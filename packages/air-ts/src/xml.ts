/**
 * XML parsing layer for air-ts.
 *
 * Produces an ordered element tree (`XmlElement`) that stands in for Python's
 * `xml.etree.ElementTree` Element. Both the model parser and the canonicalizer
 * consume this tree, exactly as the Python parser and canonicalizer consume an
 * ElementTree.
 *
 * Backend: fast-xml-parser with `preserveOrder: true`, so document order of
 * sibling elements is retained (the canonicalizer relies on stable ordering).
 * We deliberately do NOT use the browser `DOMParser` -- tests run in Node and
 * the engine must run in a Web Worker too (epic #6).
 *
 * Parity choices matched to CPython's `ET.parse` / `ET.fromstring`:
 *   - COMMENTS ARE DROPPED. ElementTree's default TreeBuilder ignores comments,
 *     so several corpus inputs that contain <!-- ... --> canonicalize with the
 *     comments gone. FXP is configured with commentPropName unset so comments
 *     never enter the tree.
 *   - CDATA is merged into element text (ElementTree resolves CDATA to text).
 *   - Entity/char refs (&amp;, &#65;) are resolved to their characters.
 *   - Only the FIRST/last text run around children is kept per node the way the
 *     model parser needs; for canonicalization we preserve text + tail per the
 *     minidom rules (see canonicalizer.ts). ElementTree keeps `.text` (before
 *     the first child) and each child's `.tail` (after it); we model this by
 *     interleaving text nodes with element nodes in `children`.
 *
 * Security (the shared XML security contract, docs/xml_security.md, issue #43):
 * DOCTYPE and entity *declarations* are rejected outright (SEC-001), input is
 * capped at 5 MB (SEC-002), nesting depth at 64 (SEC-003), attribute count at
 * 256 per element (SEC-004), attribute-value length at 65536 (SEC-005), total
 * element count at 100000 (SEC-006); non-UTF-8 input is refused (SEC-007) and a
 * numeric char ref to an XML-1.0-invalid code point is rejected (SEC-008). The
 * SAME limits and codes are enforced by the Python oracle
 * (packages/core/src/air/xml_security.py); the differential fuzzer (#43)
 * compares the two engines' accept/reject + code on every mutated input.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

/** A text run between/around child elements (models ElementTree text/tail). */
export interface XmlText {
  kind: "text";
  value: string;
}

/** An element node with insertion-ordered attributes and ordered children. */
export interface XmlElement {
  kind: "element";
  tag: string;
  /** Attributes in document order (Map preserves insertion order). */
  attrib: Map<string, string>;
  /** Ordered children: elements interleaved with text runs. */
  children: XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

// The shared XML security contract (issue #43, docs/xml_security.md). These
// limits are the single source of truth and are kept in lockstep with the
// Python oracle (packages/core/src/air/xml_security.py). Each has a registered
// SEC- diagnostic code so both engines reject a hostile input with the SAME
// code, which the differential fuzzer compares.
export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB (SEC-002).
export const MAX_DEPTH = 64; // element nesting depth (SEC-003).
export const MAX_ATTR_COUNT = 256; // attributes on one element (SEC-004).
export const MAX_ATTR_VALUE_LEN = 65536; // one attribute value length (SEC-005).
export const MAX_ELEMENT_COUNT = 100_000; // total elements per document (SEC-006).

/**
 * A violation of the shared XML security contract. Carries the registered
 * `SEC-` diagnostic code (see registry/diagnostics.json) so callers and the
 * differential harness get a stable, cross-engine identifier, not just a
 * message string.
 */
export class XmlSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "XmlSecurityError";
    this.code = code;
  }
}

export class XmlParseError extends Error {
  /**
   * Optional registered diagnostic code. Most malformed-XML rejections are
   * expat "not well-formed" errors with no dedicated code (`code` is
   * undefined); the invalid-char-ref rejection carries SEC-008 so the
   * differential harness can compare rejection classes for that case.
   */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "XmlParseError";
    this.code = code;
  }
}

const ATTR_PREFIX = "@_";
const TEXT_KEY = "#text";

/**
 * Parse XML text into an ordered element tree. Throws XmlSecurityError for the
 * conservative security limits and XmlParseError for malformed input or a
 * missing single root element.
 */
export function parseXml(xmlText: string): XmlElement {
  enforceSecurity(xmlText);

  // PARITY (#76): apply expat's PARSE-TIME whitespace normalization to the raw
  // source BEFORE well-formedness checking, reference gating, and parsing. expat
  // normalizes LITERAL whitespace during tokenization (line endings across the
  // whole document; TAB/LF inside attribute values -> space), and it does so
  // BEFORE expanding any character/entity reference. Because we transform the raw
  // source here -- where "&#13;" is still five literal characters, not a CR --
  // char-ref-introduced whitespace passes through unchanged, exactly as expat
  // preserves it. See normalizeXmlWhitespace for the verified transforms.
  const src = normalizeXmlWhitespace(xmlText);

  // Well-formedness gate. FXP's parser is lenient (it happily accepts unclosed
  // tags); the validator enforces matched tags the way expat does. It does NOT
  // catch every expat rejection (undefined named entities, multiple roots),
  // which we handle separately below.
  const validation = XMLValidator.validate(src, {
    allowBooleanAttributes: false,
  });
  if (validation !== true) {
    const e = validation.err;
    throw new XmlParseError(
      `malformed XML: ${e.code} at line ${e.line}, col ${e.col}: ${e.msg}`,
    );
  }

  // Numeric-character-reference gate (PR #77 rework round 1): expat REJECTS a
  // char ref whose code point fails the XML 1.0 Char production ("reference to
  // invalid character number"), while fast-xml-parser resolves-and-drops it.
  // Enforce the oracle's accept/reject decision before handing FXP the input.
  rejectInvalidCharRefs(src);

  // PARITY (#75): reject undefined named entities (&nbsp; &foo; &copy; ...) and
  // malformed reference syntax (bare &, &#X42; uppercase-X hex, &#; empty ref)
  // that fast-xml-parser tolerates but expat rejects. Runs AFTER the numeric
  // gate so an invalid-code-point ref keeps its SEC-008 code (the oracle reports
  // SEC-008 too) rather than the plain codes=[] reject this gate raises.
  rejectBadReferences(src);

  // Literal-control-char gate (issue #36 cross-engine seam / the literal sub-case
  // of tracked #78): expat REJECTS a LITERAL XML-1.0-invalid control char anywhere
  // in the document as "not well-formed (invalid token)", while fast-xml-parser
  // preserves the byte and builds a model. Enforce expat's decision here, AFTER
  // the numeric-char-ref gate (matching the oracle's order: SEC-008 char refs are
  // checked before the structural pass that rejects the literal char) so a
  // control-char design is refused identically by both engines.
  rejectInvalidControlChars(xmlText);

  const parser = new XMLParser({
    // Ordered array-of-nodes representation: each node is a single-key object,
    // e.g. { system: [ ...children ], ":@": { "@_name": "x" } }.
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    // Keep every attribute/text value as a raw string; never coerce "3.3" to a
    // number or "true" to a boolean. The oracle treats all XML data as text.
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    // Drop comments (ElementTree default). Do not set commentPropName.
    // Merge CDATA into text (ElementTree resolves CDATA to text).
    cdataPropName: false as unknown as string,
    // Resolve entities. processEntities handles the 5 predefined XML entities;
    // htmlEntities additionally resolves numeric char refs (&#65; / &#x42;),
    // which expat also resolves for valid XML. Numeric refs to XML-invalid
    // code points are REJECTED before this parser runs (rejectInvalidCharRefs
    // above), matching expat's "reference to invalid character number".
    // PARITY (#75, FIXED): htmlEntities would also resolve named HTML entities
    // such as &nbsp; -- which expat REJECTS as undefined -- and would tolerate
    // malformed reference syntax (&#X42;, &#;, bare &) that expat rejects as
    // not-well-formed. rejectBadReferences above now REJECTS every such input
    // before FXP runs, so by the time htmlEntities acts the only references left
    // are the 5 predefined entities and valid numeric refs, exactly the set
    // expat resolves. htmlEntities therefore never diverges from expat here.
    processEntities: true,
    htmlEntities: true,
    ignorePiTags: true,
    // No forced arrays; preserveOrder already gives us positional structure.
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(src);
  } catch (err) {
    throw new XmlParseError(
      `XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const roots = collectElements(parsed as OrderedNode[]);
  if (roots.length === 0) {
    throw new XmlParseError("no root element found");
  }
  if (roots.length > 1) {
    // expat rejects "junk after document element"; a well-formed XML document
    // has exactly one root element.
    throw new XmlParseError("junk after document element (multiple roots)");
  }
  const root = roots[0] as XmlElement;
  enforceStructure(root, 1, { elements: 0 });
  return root;
}

// --- Security gate ---------------------------------------------------------- #

function enforceSecurity(xmlText: string): void {
  // Encoding policy (SEC-007): the string handed to parseXml is already decoded
  // UTF-16 in JS, so an encoding= declaration naming a non-UTF-8 charset is the
  // detectable hostile case (a UTF-16/UTF-32 byte payload is refused by the
  // byte-level gate in index/callers before it becomes a string; here we catch
  // a mismatched declaration). This keeps the oracle and air-ts agreeing on the
  // UTF-8-only decision. A UTF-8 BOM (U+FEFF) at the start is tolerated.
  const declMatch = /^﻿?\s*<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(
    xmlText,
  );
  if (declMatch) {
    const name = (declMatch[1] as string).trim().toLowerCase();
    if (name !== "utf-8" && name !== "utf8") {
      throw new XmlSecurityError(
        "SEC-007",
        `declared encoding '${name}' is not permitted (UTF-8 only)`,
      );
    }
  }
  // Byte length (UTF-8) cap (SEC-002). TextEncoder is a standard global in
  // browser, Web Worker, and Node, so no Node-only Buffer fallback is needed.
  const byteLen = new TextEncoder().encode(xmlText).length;
  if (byteLen > MAX_INPUT_BYTES) {
    throw new XmlSecurityError(
      "SEC-002",
      `input exceeds ${MAX_INPUT_BYTES}-byte limit (${byteLen} bytes)`,
    );
  }
  // Reject DOCTYPE and entity declarations outright (SEC-001): XXE /
  // entity-expansion surface. A conservative textual scan is sufficient: expat
  // would otherwise process a <!DOCTYPE ...> and any <!ENTITY ...> it declares.
  if (/<!DOCTYPE/.test(xmlText)) {
    throw new XmlSecurityError("SEC-001", "DOCTYPE declarations are not permitted");
  }
  if (/<!ENTITY/.test(xmlText)) {
    throw new XmlSecurityError("SEC-001", "entity declarations are not permitted");
  }
  // Depth (SEC-003) and element count (SEC-006) are enforced by a COUNTING
  // textual pre-scan here -- BEFORE fast-xml-parser runs -- so we own the
  // decision (and its SEC- code) rather than letting FXP's built-in
  // "Maximum nested tags exceeded" fire first with no code, and so the cap is
  // enforced by counting rather than by catching a parser stack overflow
  // (issue #43 guardrail). Attribute count/length (SEC-004/005) are checked in
  // the post-parse tree walk (enforceStructure), where attribute structure is
  // already available.
  enforceDepthAndCountByScan(xmlText);
}

/**
 * Count element open/close markup in a single linear pass and enforce the depth
 * (SEC-003) and element-count (SEC-006) caps. This is a tolerant scan: it does
 * not require well-formed XML (the well-formedness gate runs separately), it
 * just tracks nesting from `<tag ...>` / `</tag>` / `<tag/>` markers, skipping
 * comments, CDATA, PIs, and the XML declaration. Enough to bound a hostile
 * 1000-deep or million-element document before the real parser allocates.
 */
function enforceDepthAndCountByScan(xmlText: string): void {
  let depth = 0;
  let elementCount = 0;
  let i = 0;
  const n = xmlText.length;
  while (i < n) {
    const lt = xmlText.indexOf("<", i);
    if (lt === -1) break;
    if (xmlText.startsWith("<!--", lt)) {
      const end = xmlText.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xmlText.startsWith("<![CDATA[", lt)) {
      const end = xmlText.indexOf("]]>", lt + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xmlText.startsWith("<?", lt) || xmlText.startsWith("<!", lt)) {
      const end = xmlText.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = xmlText.indexOf(">", lt);
    if (gt === -1) break;
    const isClose = xmlText[lt + 1] === "/";
    const isSelfClose = xmlText[gt - 1] === "/";
    if (isClose) {
      depth -= 1;
    } else {
      elementCount += 1;
      if (elementCount > MAX_ELEMENT_COUNT) {
        throw new XmlSecurityError(
          "SEC-006",
          `element count exceeds ${MAX_ELEMENT_COUNT}`,
        );
      }
      if (!isSelfClose) {
        depth += 1;
        if (depth > MAX_DEPTH) {
          throw new XmlSecurityError(
            "SEC-003",
            `nesting depth exceeds ${MAX_DEPTH}`,
          );
        }
      }
    }
    i = gt + 1;
  }
}

// --- Byte-level encoding gate (SEC-007) ------------------------------------- #

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * Enforce the UTF-8-only encoding policy on RAW bytes and decode to text
 * (SEC-007), mirroring the oracle's `enforce_encoding`. Untrusted XML arrives as
 * bytes (a share-link blob, an imported file); this is the byte-level entry
 * point that refuses UTF-16/UTF-32 (by BOM) and non-UTF-8 byte sequences, so
 * both engines make the SAME UTF-8-only decision. A UTF-8 BOM is tolerated and
 * stripped. Once decoded, callers hand the string to `parseXml`, which runs the
 * rest of the contract.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  // UTF-32 BOMs first (UTF-32-LE begins with the UTF-16-LE BOM bytes).
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) ||
    (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new XmlSecurityError("SEC-007", "UTF-32 input is not permitted (UTF-8 only)");
  }
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    throw new XmlSecurityError("SEC-007", "UTF-16 input is not permitted (UTF-8 only)");
  }
  let body = bytes;
  if (bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2]) {
    body = bytes.subarray(3);
  }
  // Strict UTF-8 decode: `fatal: true` throws on any invalid byte sequence,
  // exactly as the oracle's `body.decode("utf-8")` raises UnicodeDecodeError.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new XmlSecurityError("SEC-007", "input is not valid UTF-8 (UTF-8 only)");
  }
}

/**
 * Parse raw XML bytes: enforce the UTF-8-only policy (SEC-007), then parse the
 * decoded text through the full contract. The byte-level counterpart to
 * `parseXml` for untrusted input that arrives as bytes.
 */
export function parseXmlBytes(bytes: Uint8Array): XmlElement {
  return parseXml(decodeXmlBytes(bytes));
}

// --- Numeric character reference gate (PR #77 rework round 1) --------------- #

/**
 * Reject numeric character references to XML-1.0-invalid code points, exactly
 * as expat does ("reference to invalid character number").
 *
 * PROVENANCE (oracle, `xml.etree.ElementTree.fromstring`, run at rework time):
 *   REJECT: &#0; &#8; &#11; &#12; &#27; &#31; (C0 controls other than 9/A/D),
 *           &#55296;..&#57343; (surrogates D800-DFFF), &#65534; &#65535;
 *           (FFFE/FFFF), &#1114112; (0x110000) and anything larger.
 *   ACCEPT: &#9; &#10; &#13; &#32; &#127; &#55295; (D7FF), &#57344; (E000),
 *           &#65533; (FFFD), &#65536; (10000), &#1114111; (10FFFF), hex forms
 *           with either-case hex digits (&#xD7FF; / &#xd7ff;).
 *   CONTEXT: refs are NOT processed (and never rejected) inside comments,
 *           CDATA sections, and processing instructions; they ARE processed in
 *           element text and attribute values. `&amp;#8;` is not a reference.
 *
 * The scan runs on raw text AFTER the well-formedness gate, with the three
 * unprocessed span kinds stripped first. In well-formed XML a literal `<` is
 * impossible outside markup, so `<!--`, `<![CDATA[` and `<?` always open a real
 * span, and the lazy matches end at the true terminators (a well-formed comment
 * cannot contain `--`, character data cannot contain `]]>`).
 *
 * Malformed reference SYNTAX (&#X42;, &#;, bare &) is a different expat error
 * class ("not well-formed") and is rejected by rejectBadReferences (#75), which
 * runs immediately after this gate. This gate owns ONLY the invalid-code-point
 * case, which carries the distinct SEC-008 code.
 */
function rejectInvalidCharRefs(xmlText: string): void {
  // Spans in which expat does not process character references.
  const scannable = xmlText.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g,
    "",
  );
  // Syntactically valid numeric char refs only: decimal or lowercase-x hex.
  const charRef = /&#(?:([0-9]+)|x([0-9a-fA-F]+));/g;
  let m: RegExpExecArray | null;
  while ((m = charRef.exec(scannable)) !== null) {
    const cp =
      m[1] !== undefined
        ? parseInt(m[1], 10)
        : parseInt(m[2] as string, 16);
    if (!isXmlChar(cp)) {
      // SEC-008: expat rejects a ref to an XML-1.0-invalid code point. We raise
      // XmlParseError (not XmlSecurityError) to preserve #7's error TYPE, but
      // attach the SEC-008 code so the differential harness sees the same
      // rejection class the oracle reports.
      throw new XmlParseError(
        `reference to invalid character number: ${m[0]}`,
        "SEC-008",
      );
    }
  }
}

/**
 * A LITERAL character that is NOT in the XML 1.0 `Char` production. The valid
 * chars are #x9 (tab), #xA (LF), #xD (CR), #x20-#xD7FF, #xE000-#xFFFD,
 * #x10000-#x10FFFF; so the invalid C0 range is #x0-#x8, #xB, #xC, #xE-#x1F.
 * DEL (#x7F) is a VALID XML char and is NOT matched here.
 */
const INVALID_LITERAL_CONTROL_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * Reject a LITERAL XML-1.0-invalid control character anywhere in the document,
 * exactly as expat does ("not well-formed (invalid token)").
 *
 * PROVENANCE (oracle, `xml.etree.ElementTree.fromstring`, probed at fix time):
 *   REJECT (literal): #x0-#x8, #xB, #xC, #xE-#x1F -- in EVERY context (element
 *     text, attribute value, comment, CDATA section, processing instruction, and
 *     the whitespace between tags); the XML 1.0 Char production governs every
 *     character in the document, not just element content.
 *   ACCEPT (literal): #x9 (tab), #xA (LF), #xD (CR), and #x7F (DEL) -- expat
 *     accepts these and air-ts preserves them; we keep that parity and do NOT
 *     reject them.
 *
 * Sibling gate to `rejectInvalidCharRefs`: that one handles the numeric-char-REF
 * form (`&#8;`, resolved+dropped by fast-xml-parser); this one handles the
 * LITERAL byte (preserved verbatim by fast-xml-parser). Without this gate, a
 * control-char-bearing firmware `<source>` (or any text) parses in air-ts but is
 * rejected by the Python oracle -- the literal-control-char sub-case of the
 * FXP-vs-expat well-formedness family (#78). We scan the WHOLE input (not the
 * char-ref "scannable" subset) because expat rejects the literal char in every
 * span kind, including comments/CDATA/PIs.
 *
 * Raised as a code-less `XmlParseError` (not a SEC- code), matching the oracle's
 * `XmlParseRejection` -> reject with `codes: []` (fuzz_eval.py): a plain
 * not-well-formed rejection, so the differential harness sees both engines refuse
 * with the same (empty) rejection class.
 */
function rejectInvalidControlChars(xmlText: string): void {
  const match = INVALID_LITERAL_CONTROL_CHAR.exec(xmlText);
  if (match !== null) {
    const cp = xmlText.charCodeAt(match.index);
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    throw new XmlParseError(
      `not well-formed (invalid token): literal control character U+${hex} ` +
        `is not a legal XML 1.0 character`,
    );
  }
}

/**
 * XML 1.0 `Char` production:
 * #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
 */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

// --- Undefined / malformed reference gate (issue #75) ----------------------- #

/**
 * A syntactically- AND semantically-valid XML reference, anchored at an `&`:
 * one of the 5 predefined entities, a decimal char ref, or a lowercase-x hex
 * char ref. This is EXACTLY the set expat accepts in a document with no DTD
 * (DOCTYPE is rejected outright, SEC-001, so no other named entity can be
 * defined). Code-point validity of numeric refs is enforced separately by
 * rejectInvalidCharRefs (SEC-008); here the numeric alternatives are syntactic.
 */
const VALID_REF_RE = /&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/y;

/**
 * Reject undefined named entities and malformed reference syntax, matching
 * expat's decision (issue #75).
 *
 * PARITY (oracle, `xml.etree.ElementTree.fromstring`, verified at build time):
 *   REJECT (expat "undefined entity"): any named reference other than the five
 *     predefined -- &nbsp; &foo; &copy; ... -- in TEXT and in ATTRIBUTE VALUES.
 *   REJECT (expat "not well-formed"): malformed reference syntax -- a bare `&`,
 *     an uppercase-X hex ref &#X42;, an empty ref &#;, a named ref with no `;`.
 *   ACCEPT: the five predefined entities and valid numeric refs (&#65; &#x42;).
 *   CONTEXT: references are NOT processed inside comments, CDATA sections, or
 *     processing instructions, so a `&` there is literal and MUST NOT be flagged
 *     (verified: <a><!-- &nbsp; --></a> and <a><![CDATA[&foo;]]></a> both ACCEPT).
 *
 * fast-xml-parser diverges: with htmlEntities it RESOLVES &nbsp;/&copy; to a
 * character and keeps &foo; literal, and in attribute values it even resolves
 * &#X42; and tolerates a bare `&` -- all inputs expat rejects. This gate makes
 * air-ts reach expat's accept/reject decision instead. Every rejection here is a
 * plain XmlParseError with NO code, which maps to the oracle's `reject` with an
 * empty `codes` set (expat surfaces these as an ordinary ParseError, not a
 * security-contract violation), so the differential harness sees the same
 * rejection class.
 *
 * The scan mirrors rejectInvalidCharRefs: strip the three unprocessed span kinds
 * first, then walk every remaining `&`. In well-formed XML a `&` can only appear
 * in text or an attribute value, and after stripping comment/CDATA/PI spans any
 * `&` left that does not open a VALID_REF_RE reference is one expat rejects.
 */
function rejectBadReferences(xmlText: string): void {
  const scannable = xmlText.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g,
    // Replace with same-length blanks would be ideal, but position is not
    // reported to the user; a plain removal is enough since we only test whether
    // a valid reference begins at each surviving `&`.
    "",
  );
  let i = 0;
  const n = scannable.length;
  while (i < n) {
    const amp = scannable.indexOf("&", i);
    if (amp === -1) break;
    VALID_REF_RE.lastIndex = amp;
    if (!VALID_REF_RE.test(scannable)) {
      throw new XmlParseError(
        `undefined or malformed entity reference: ${scannable.slice(amp, amp + 16)}`,
      );
    }
    // Continue AFTER the matched reference so an inner `&` (there is none in a
    // valid ref) is never rescanned; lastIndex is the char past the ';'.
    i = VALID_REF_RE.lastIndex;
  }
}

// --- Parse-time whitespace normalization (issue #76) ------------------------ #

/**
 * Apply expat's PARSE-TIME whitespace normalization to raw XML source,
 * reproducing the two transforms expat performs on LITERAL characters during
 * tokenization -- BEFORE any character/entity reference is expanded.
 *
 * PARITY (#76, verified against CPython xml.etree.ElementTree / expat):
 *   1. XML 1.0 s2.11 line-ending normalization, over the WHOLE document (text,
 *      CDATA, and attribute values alike): a CRLF ("\r\n") or a lone CR ("\r")
 *      becomes a single LF ("\n"). Verified: <a>p\rq</a> -> text "p\nq";
 *      <![CDATA[p\rq]]> -> "p\nq".
 *   2. XML 1.0 s3.3.3 attribute-value whitespace normalization: within a start-
 *      or empty-element tag, each remaining literal TAB ("\t") or LF ("\n")
 *      inside a quoted attribute value becomes a single SPACE -- each character
 *      maps to one space; runs are NOT collapsed. Verified: <a x="p\tq"/> ->
 *      x="p q"; <a x="p\r\rq"/> -> x="p  q" (two spaces, from two CR->LF->space).
 *
 * CRUCIAL: expat applies these to LITERAL source characters only. A TAB/LF/CR
 * introduced via a character reference (&#9; / &#10; / &#13;) is NOT literal at
 * this stage and passes through UNCHANGED -- verified: <a x="p&#13;q"/> keeps
 * x="p\rq"; <a>p&#13;q</a> keeps text "p\rq". Because this runs on the RAW source
 * (where "&#13;" is the five characters &,#,1,3,;) BEFORE fast-xml-parser expands
 * references, char-ref-introduced whitespace is preserved exactly as expat
 * preserves it, while literal whitespace is normalized exactly as expat does.
 *
 * fast-xml-parser performs NEITHER transform (it keeps literal tabs/newlines/CR
 * verbatim in both text and attribute values), so without this pre-pass the
 * parsed model and the canonical serialization diverge from the oracle for such
 * inputs (#76). Line-ending normalization is a global string replace; the
 * attribute-value pass uses a quote-aware scanner so a literal TAB/LF is touched
 * ONLY inside a real element tag's quoted value -- never in text content, a
 * comment, CDATA, or a PI (where expat leaves them alone).
 */
function normalizeXmlWhitespace(src: string): string {
  // Step 1: line-ending normalization across the whole document.
  const s = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Fast path: nothing left to normalize if there is no TAB or LF at all (the
  // only literals step 2 acts on). Keeps the common corpus/test inputs an exact
  // identity transform with no scanning cost.
  if (s.indexOf("\t") === -1 && s.indexOf("\n") === -1) return s;

  // Step 2: attribute-value whitespace normalization inside element tags only.
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] !== "<") {
      // Text content: expat keeps literal TAB/LF here; copy verbatim.
      const lt = s.indexOf("<", i);
      const stop = lt === -1 ? n : lt;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      out += s.slice(i, stop); // comment: no attribute values; copy verbatim
      i = stop;
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      const stop = end === -1 ? n : end + 3;
      out += s.slice(i, stop); // CDATA: character data; copy verbatim
      i = stop;
      continue;
    }
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += s.slice(i, stop); // PI: copy verbatim
      i = stop;
      continue;
    }
    if (s.startsWith("<!", i)) {
      // A declaration (e.g. DOCTYPE, rejected elsewhere): no quoted attribute
      // values to normalize; copy up to the terminating '>'.
      const end = s.indexOf(">", i + 2);
      const stop = end === -1 ? n : end + 1;
      out += s.slice(i, stop);
      i = stop;
      continue;
    }
    // An element tag: <tag ...>, </tag>, or <tag .../>. Walk quote-aware to the
    // closing '>', normalizing TAB/LF -> space only inside a quoted value ('>'
    // is legal inside an attribute value, so a naive indexOf(">") would be wrong).
    let j = i + 1;
    let tag = "<";
    while (j < n && s[j] !== ">") {
      const ch = s[j] as string;
      if (ch === '"' || ch === "'") {
        let k = j + 1;
        while (k < n && s[k] !== ch) k += 1;
        tag += ch + s.slice(j + 1, k).replace(/[\t\n]/g, " ");
        if (k < n) {
          tag += ch; // closing quote
          j = k + 1;
        } else {
          j = k; // unterminated quote; well-formedness gate will reject
        }
      } else {
        tag += ch;
        j += 1;
      }
    }
    if (j < n) {
      tag += ">";
      j += 1;
    }
    out += tag;
    i = j;
  }
  return out;
}

/**
 * Enforce the structural caps by COUNTING during a single tree walk (issue #43
 * guardrail: depth/count are enforced by counting, never by catching a stack
 * overflow): depth (SEC-003), total element count (SEC-006), per-element
 * attribute count (SEC-004), and per-attribute value length (SEC-005). The
 * counter object is shared across the recursion so the element total is a
 * running document-wide count.
 */
function enforceStructure(
  el: XmlElement,
  depth: number,
  counter: { elements: number },
): void {
  if (depth > MAX_DEPTH) {
    throw new XmlSecurityError("SEC-003", `nesting depth exceeds ${MAX_DEPTH}`);
  }
  counter.elements += 1;
  if (counter.elements > MAX_ELEMENT_COUNT) {
    throw new XmlSecurityError(
      "SEC-006",
      `element count exceeds ${MAX_ELEMENT_COUNT}`,
    );
  }
  if (el.attrib.size > MAX_ATTR_COUNT) {
    throw new XmlSecurityError(
      "SEC-004",
      `element <${el.tag}> has ${el.attrib.size} attributes (limit ${MAX_ATTR_COUNT})`,
    );
  }
  for (const value of el.attrib.values()) {
    if (value.length > MAX_ATTR_VALUE_LEN) {
      throw new XmlSecurityError(
        "SEC-005",
        `attribute value on <${el.tag}> exceeds ${MAX_ATTR_VALUE_LEN} characters`,
      );
    }
  }
  for (const child of el.children) {
    if (child.kind === "element") {
      enforceStructure(child, depth + 1, counter);
    }
  }
}

// --- FXP ordered-node conversion ------------------------------------------- #

/**
 * FXP preserveOrder node: a single-real-key object whose value is the ordered
 * child list, plus an optional ":@" attribute bag. Text nodes use the "#text"
 * key with a string value.
 */
interface OrderedNode {
  [key: string]: unknown;
  ":@"?: Record<string, string>;
}

/** Convert an FXP ordered child array into our XmlNode children. */
function collectElements(nodes: OrderedNode[]): XmlNode[] {
  const out: XmlNode[] = [];
  if (!Array.isArray(nodes)) return out;
  for (const node of nodes) {
    const keys = Object.keys(node).filter((k) => k !== ":@");
    // A node has exactly one content key in preserveOrder mode.
    const key = keys[0];
    if (key === undefined) continue;
    if (key === TEXT_KEY) {
      out.push({ kind: "text", value: stringifyText(node[TEXT_KEY]) });
      continue;
    }
    const childArray = node[key] as OrderedNode[];
    const attribBag = node[":@"] ?? {};
    const attrib = new Map<string, string>();
    for (const [ak, av] of Object.entries(attribBag)) {
      if (ak.startsWith(ATTR_PREFIX)) {
        attrib.set(ak.slice(ATTR_PREFIX.length), stringifyText(av));
      }
    }
    out.push({
      kind: "element",
      tag: key,
      attrib,
      children: collectElements(Array.isArray(childArray) ? childArray : []),
    });
  }
  return out;
}

function stringifyText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

// --- Convenience accessors mirroring ElementTree usage --------------------- #

/** Immediate element children of `el` (text runs excluded). */
export function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.kind === "element") out.push(c);
  }
  return out;
}

/** All direct child elements with the given tag (ElementTree `findall(tag)`). */
export function findAll(el: XmlElement, tag: string): XmlElement[] {
  return childElements(el).filter((c) => c.tag === tag);
}

/** First direct child element with the given tag, or null (ET `find(tag)`). */
export function find(el: XmlElement, tag: string): XmlElement | null {
  for (const c of el.children) {
    if (c.kind === "element" && c.tag === tag) return c;
  }
  return null;
}

/**
 * ElementTree `.text`: the concatenated text that appears BEFORE the first
 * child element (ET stores only the leading text run in `.text`). For a
 * leaf element this is its full text content.
 */
export function elementText(el: XmlElement): string {
  const parts: string[] = [];
  for (const c of el.children) {
    if (c.kind === "text") {
      parts.push(c.value);
    } else {
      break; // stop at the first element child
    }
  }
  return parts.join("");
}

/** Get an attribute value or a fallback (ElementTree `attrib.get`). */
export function attr(el: XmlElement, name: string, fallback = ""): string {
  const v = el.attrib.get(name);
  return v === undefined ? fallback : v;
}

/** Whether an attribute is present (ElementTree `name in attrib`). */
export function hasAttr(el: XmlElement, name: string): boolean {
  return el.attrib.has(name);
}
