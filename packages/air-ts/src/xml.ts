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

  // Well-formedness gate. FXP's parser is lenient (it happily accepts unclosed
  // tags); the validator enforces matched tags the way expat does. It does NOT
  // catch every expat rejection (undefined named entities, multiple roots),
  // which we handle separately below / accept as a documented pre-#43 gap.
  const validation = XMLValidator.validate(xmlText, {
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
  rejectInvalidCharRefs(xmlText);

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
    // PARITY (pre-#43 gap, issue #75): htmlEntities also resolves named HTML
    // entities such as &nbsp; that expat REJECTS as undefined, and FXP accepts
    // malformed reference syntax (&#X42; resolved, &#; left literal, bare &)
    // that expat rejects as not-well-formed. The corpus uses none of these, so
    // corpus parity is unaffected; #43's fuzzer contract will formalize entity
    // handling in docs/xml_security.md.
    processEntities: true,
    htmlEntities: true,
    ignorePiTags: true,
    // No forced arrays; preserveOrder already gives us positional structure.
  });

  let parsed: unknown;
  try {
    parsed = parser.parse(xmlText);
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
 * class ("not well-formed") and stays in the #75 accept-vs-reject family --
 * FXP resolves or keeps those literally; see the parser-options PARITY note.
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
