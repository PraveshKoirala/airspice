/**
 * Port of `packages/core/src/air/canonicalizer.py`.
 *
 * Produces the byte-identical `canonical.air.xml`. The oracle pipeline is:
 *   1. deepcopy(root)
 *   2. sort every element's attributes (recursively)
 *   3. reorder top-level sections by SECTION_ORDER (unknown tags kept, appended)
 *   4. within id-bearing sections, sort children by their `id` attr (fallback
 *      to the child tag when there is no id)
 *   5. ET.tostring(root) -> minidom.parseString -> toprettyxml(indent="  ")
 *   6. drop blank lines, join with "\n", append a trailing "\n"
 *
 * IMPORTANT (parity): the canonicalizer runs on the RAW, un-normalized tree.
 * `parse_file` returns the original parsed tree (parse_tree rebinds `tree`
 * locally), and the exporter feeds THAT to canonicalize_tree. So comments are
 * already gone (ElementTree drops them), but none of the normalizer's coercions
 * apply here. index.ts preserves this by canonicalizing the parsed raw tree.
 *
 * Steps 5-6 are reproduced by a hand-written serializer that mimics minidom's
 * `toprettyxml` output exactly (see serializeMinidomStyle). We do NOT round-trip
 * through a second XML library: controlling every byte is the only reliable way
 * to stay byte-identical to CPython's minidom.
 */

import { type XmlElement, type XmlNode } from "./xml.js";
import { cloneElement } from "./normalizer.js";

const SECTION_ORDER = [
  "metadata",
  "requirements",
  "nets",
  "power_domains",
  "components",
  "interfaces",
  "analog",
  "digital",
  "firmware",
  "bridges",
  "tests",
  "simulation_profiles",
  "exports",
  "gui",
];

// Sections whose children are sorted by `id` (fallback: child tag).
const ID_SORTED_SECTIONS = new Set<string>([
  "nets",
  "power_domains",
  "components",
  "interfaces",
  "tests",
  "simulation_profiles",
]);

// Canonical position of the optional <gui> child within a <component>
// (issue #22). The rule is deliberately MINIMAL to keep the pre-#22 corpus
// byte-identical: only <gui> children are relocated -- everything else
// retains document order. A <gui> child is moved so it appears IMMEDIATELY
// AFTER the last <pin> child (or, if the component has no <pin>, after
// <value>; failing that, at the front). Mirrors the Python canonicalizer's
// `_order_component_children` in packages/core/src/air/canonicalizer.py.

/** Canonicalize a raw element tree to the byte-exact canonical XML string. */
export function canonicalizeTree(rawRoot: XmlElement): string {
  const root = cloneElement(rawRoot);
  sortAttributes(root);

  // Reorder top-level sections. Elements not in SECTION_ORDER keep their
  // relative order and are appended after the ordered ones (Python: stable
  // extend by section_name, then the remainder).
  const sections = childElementList(root);
  const ordered: XmlElement[] = [];
  for (const sectionName of SECTION_ORDER) {
    for (const section of sections) {
      if (section.tag === sectionName) ordered.push(section);
    }
  }
  for (const section of sections) {
    if (!SECTION_ORDER.includes(section.tag)) ordered.push(section);
  }
  // root[:] = ordered  (root now contains ONLY these elements, in this order;
  // any top-level text nodes are dropped, exactly like ElementTree slice-assign).
  root.children = ordered;

  // Within id-bearing sections, stable-sort children by id (fallback: tag).
  for (const section of root.children) {
    if (section.kind !== "element") continue;
    if (ID_SORTED_SECTIONS.has(section.tag)) {
      const childEls = childElementList(section);
      const sorted = stableSort(childEls, (child) =>
        child.attrib.get("id") ?? child.tag,
      );
      section.children = sorted;
    }
    // Within <components>, also reorder each <component>'s own children
    // into the canonical section groups (issue #22: value / pin / gui /
    // property / anything-else). Mirrors the Python canonicalizer's
    // _order_component_children.
    if (section.tag === "components") {
      for (const component of section.children) {
        if (component.kind !== "element") continue;
        orderComponentChildren(component);
      }
    }
  }

  return serializeMinidomStyle(root);
}

function orderComponentChildren(component: XmlElement): void {
  const guiChildren: XmlElement[] = [];
  const others: typeof component.children = [];
  for (const child of component.children) {
    if (child.kind === "element" && child.tag === "gui") {
      guiChildren.push(child);
    } else {
      others.push(child);
    }
  }
  if (guiChildren.length === 0) return; // No <gui> children -> keep document order verbatim.
  // Insert-after: last <pin> element -> last <value> element -> front.
  let insertAfter = -1;
  for (let i = 0; i < others.length; i++) {
    const child = others[i];
    if (child !== undefined && child.kind === "element" && child.tag === "pin") insertAfter = i;
  }
  if (insertAfter === -1) {
    for (let i = 0; i < others.length; i++) {
      const child = others[i];
      if (child !== undefined && child.kind === "element" && child.tag === "value") insertAfter = i;
    }
  }
  const ordered: typeof component.children = [];
  for (let i = 0; i <= insertAfter; i++) {
    const child = others[i];
    if (child !== undefined) ordered.push(child);
  }
  for (const g of guiChildren) ordered.push(g);
  for (let i = insertAfter + 1; i < others.length; i++) {
    const child = others[i];
    if (child !== undefined) ordered.push(child);
  }
  component.children = ordered;
}

// --- attribute sort --------------------------------------------------------- #

function sortAttributes(el: XmlElement): void {
  const entries = [...el.attrib.entries()].sort((a, b) =>
    codePointCompare(a[0], b[0]),
  );
  el.attrib = new Map(entries);
  for (const child of el.children) {
    if (child.kind === "element") sortAttributes(child);
  }
}

// --- minidom-style pretty serialization ------------------------------------- #

/**
 * Serialize like `minidom.parseString(ET.tostring(root)).toprettyxml("  ")`
 * with blank lines stripped and a single trailing newline.
 *
 * The XML declaration is `<?xml version="1.0" ?>` (note the space before `?>`),
 * indentation is two spaces per level, and per-element layout follows minidom:
 *   - no children            -> `<tag .../>`               (self-closing)
 *   - a single text child     -> `<tag ...>escaped</tag>`   (inline, one line)
 *   - element / mixed children-> block form, children indented one level.
 * After ET.tostring re-parses through minidom, an element with empty text has
 * no text child and self-closes; whitespace-only text is preserved inline.
 */
export function serializeMinidomStyle(root: XmlElement): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" ?>');
  writeElement(root, 0, lines);
  // Drop blank lines (Python: `pretty.splitlines()` keeps lines whose strip()
  // is truthy), join, add \n. The split must run over the FULL pretty string,
  // not the pushed chunks: a text run containing embedded newlines (from &#10;
  // char refs) creates interior lines inside a single chunk, and Python's
  // splitlines sees -- and drops -- a blank interior line there (live oracle:
  // <title>a&#10;  &#10;b</title> canonicalizes to "a\nb"). After
  // escapeText's line-ending normalization no \r survives in text, and control
  // chars in attributes are char-ref-escaped, so "\n" is the only separator --
  // split("\n") is then equivalent to Python's splitlines (PR #87 rework r1, F1).
  const kept = lines
    .join("\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return kept.join("\n") + "\n";
}

function writeElement(el: XmlElement, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const open = openTag(el);

  const childNodes = el.children;
  const elementChildren = childNodes.filter(
    (c): c is XmlElement => c.kind === "element",
  );
  const textChildren = childNodes.filter(
    (c): c is Extract<XmlNode, { kind: "text" }> => c.kind === "text",
  );

  // minidom writes inline when the node has exactly one child and it is Text.
  const isInlineText =
    childNodes.length === 1 && childNodes[0]?.kind === "text";

  if (childNodes.length === 0) {
    lines.push(`${indent}<${open}/>`);
    return;
  }

  if (isInlineText) {
    const text = (childNodes[0] as { value: string }).value;
    lines.push(`${indent}<${open}>${escapeText(text)}</${el.tag}>`);
    return;
  }

  // Block form. minidom emits the open tag, then each child on its own
  // (indented) line, then the close tag. Text runs interleaved with elements
  // (mixed content) are each written on their own line; after blank-line
  // stripping, empty/whitespace text runs vanish. This matches the observed
  // minidom+strip behavior. The corpus has no mixed content, so the common
  // path is: open tag / element children / close tag.
  lines.push(`${indent}<${open}>`);
  for (const child of childNodes) {
    if (child.kind === "element") {
      writeElement(child, depth + 1, lines);
    } else {
      // A text run between element children. minidom would indent it; blank
      // lines are stripped afterwards, so pure-whitespace runs produce nothing.
      const inner = "  ".repeat(depth + 1);
      lines.push(`${inner}${escapeText(child.value)}`);
    }
  }
  lines.push(`${indent}</${el.tag}>`);
  void elementChildren;
  void textChildren;
}

/** `tag attr1="v1" attr2="v2"` with attributes already sorted, values escaped. */
function openTag(el: XmlElement): string {
  let s = el.tag;
  for (const [k, v] of el.attrib) {
    s += ` ${k}="${escapeAttr(v)}"`;
  }
  return s;
}

/**
 * Text escaping as minidom emits it: & < > escaped; quotes and apostrophes are
 * left literal in text content; TAB stays literal.
 *
 * LINE-ENDING NORMALIZATION (PR #87 rework r1, F1 "pin the text path"): the
 * oracle pipeline serializes the tree with ET.tostring (which writes \r in text
 * LITERALLY) and re-parses through minidom, where expat applies XML 1.0
 * line-ending normalization to character data: \r\n -> \n, then lone \r -> \n.
 * A \r that entered text via a &#13; char ref therefore leaves the canonical
 * form as a plain newline (live oracle: <title>cr&#13;end</title> canonicalizes
 * to "cr\nend"). We reproduce that spec algorithm here, BEFORE escaping. This
 * is canonicalizer-only: serialize.ts (the ET.tostring mirror used for patch
 * preview payloads) keeps \r literal in text, matching ITS oracle stage.
 */
function escapeText(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Attribute-value escaping as minidom emits it: & < > and the double quote are
 * escaped; single quotes stay literal (minidom always quotes attrs with ").
 * Literal TAB/LF/CR are written RAW (unescaped), matching the CI oracle.
 *
 * PYTHON-VERSION-DEPENDENT ORACLE (PR #87 rework r1, F1 -- corrected round 2):
 * the oracle canonicalizer re-parses `ET.tostring(root)` through minidom, and
 * minidom's handling of control chars in ATTRIBUTE values CHANGED across CPython:
 *   - Python 3.12 (what CI pins, .github/workflows/*.yml python-version 3.12):
 *     minidom writes a literal tab/LF/CR RAW -> note="tab<TAB>lf<LF>cr<CR>end".
 *     This is a known CPython minidom bug (the output is NOT reparse-stable: a
 *     raw LF in an attribute is normalized to a space by expat on the next
 *     parse). The golden corpus and every parity job are generated on 3.12, so
 *     3.12 IS the authoritative oracle for this port.
 *   - Python 3.13+ (gh-124061): minidom now escapes them as UNPADDED char refs
 *     &#9;/&#10;/&#13;, which IS reparse-stable.
 * air-ts must match the oracle CI runs, byte-for-byte (AGENTS.md rule 4), so we
 * emit the RAW 3.12 form here -- reproducing the oracle's behavior, including its
 * non-reparse-stable quirk, rather than "fixing" it in the port. The first
 * revision of this rework escaped the char refs (matching the local dev box's
 * Python 3.14); that made air-ts diverge from the 3.12 CI oracle and the two
 * attr fixtures went stale in CI. See docs and the version-dependency note on
 * the attr_whitespace fixtures. When CI's Python is bumped to >=3.13, this
 * function and those fixtures must switch to the char-ref form together (an
 * oracle-first change, since it moves the golden bytes).
 *
 * LINE-ENDING NORMALIZATION applies to attribute values too, on BOTH versions:
 * the oracle's ET.tostring writes the value and minidom re-parses it through
 * expat, which normalizes \r\n->\n and lone \r->\n in attribute values just as
 * it does in text (verified on 3.12: v="X&#13;Y" -> v="X<LF>Y", v="X&#13;&#10;Y"
 * -> single <LF>). We reproduce that here, BEFORE escaping. \t and \n survive
 * RAW on 3.12 after normalization.
 *
 * NB the serialize.ts ET.tostring mirror (patch preview payloads) is UNaffected:
 * ElementTree's own _escape_attrib escapes \t\n\r as PADDED &#09;/&#10;/&#13; on
 * ALL these Python versions (verified 3.12 and 3.14) and does NOT line-ending-
 * normalize (it serializes the in-memory tree directly, no expat re-parse), so
 * serialize.ts stays as is and matches ITS oracle stage.
 *
 * (Literal tabs/newlines in the ORIGINAL input's attributes are normalized to
 * spaces by expat at parse time; FXP does not reproduce that -- the pre-#43
 * parse-time edge, out of corpus scope. This function handles the chars that
 * reach the tree via char refs, which both parsers preserve into the tree.)
 */
function escapeAttr(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- small utilities -------------------------------------------------------- #

function childElementList(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.kind === "element") out.push(c);
  }
  return out;
}

/** Stable sort by a string key using Python code-point order. */
function stableSort(
  items: XmlElement[],
  key: (el: XmlElement) => string,
): XmlElement[] {
  return items
    .map((el, i) => ({ el, i, k: key(el) }))
    .sort((a, b) => {
      const c = codePointCompare(a.k, b.k);
      return c !== 0 ? c : a.i - b.i;
    })
    .map((x) => x.el);
}

function codePointCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
