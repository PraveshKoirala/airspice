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
 * Security (conservative pre-#43 defaults, see docs/xml_security.md when it
 * lands): DOCTYPE and entity *declarations* are rejected outright, input is
 * capped at 5 MB, and nesting depth is capped at 64. These are intentionally
 * strict starting points, not the final formal contract.
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

export const MAX_INPUT_BYTES = 5 * 1024 * 1024; // 5 MB, pre-#43 default.
export const MAX_DEPTH = 64; // pre-#43 default.

export class XmlSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlSecurityError";
  }
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
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
  enforceDepth(root, 1);
  return root;
}

// --- Security gate ---------------------------------------------------------- #

function enforceSecurity(xmlText: string): void {
  // Byte length (UTF-8) cap. TextEncoder is a standard global in browser,
  // Web Worker, and Node, so no Node-only Buffer fallback is needed.
  const byteLen = new TextEncoder().encode(xmlText).length;
  if (byteLen > MAX_INPUT_BYTES) {
    throw new XmlSecurityError(
      `input exceeds ${MAX_INPUT_BYTES}-byte limit (${byteLen} bytes)`,
    );
  }
  // Reject DOCTYPE and entity declarations outright (XXE / entity-expansion
  // surface). A conservative textual scan is sufficient pre-#43: expat would
  // otherwise process a <!DOCTYPE ...> and any <!ENTITY ...> it declares.
  if (/<!DOCTYPE/i.test(xmlText)) {
    throw new XmlSecurityError("DOCTYPE declarations are not permitted");
  }
  if (/<!ENTITY/i.test(xmlText)) {
    throw new XmlSecurityError("entity declarations are not permitted");
  }
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
      throw new XmlParseError(
        `reference to invalid character number: ${m[0]}`,
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

function enforceDepth(el: XmlElement, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new XmlSecurityError(`nesting depth exceeds ${MAX_DEPTH}`);
  }
  for (const child of el.children) {
    if (child.kind === "element") {
      enforceDepth(child, depth + 1);
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
