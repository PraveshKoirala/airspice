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
  }

  return serializeMinidomStyle(root);
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
  // Drop blank lines (Python: keep lines whose strip() is truthy), join, add \n.
  const kept = lines.filter((line) => line.trim() !== "");
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
 * left literal in text content.
 */
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Attribute-value escaping as minidom emits it: & < > and the double quote are
 * escaped; single quotes stay literal (minidom always quotes attrs with ").
 * (Tabs/newlines inside attribute values are normalized to spaces by the XML
 * parser at parse time; the corpus has none, and FXP does not reproduce that
 * expat normalization -- documented as a pre-#43 edge, out of corpus scope.)
 */
function escapeAttr(s: string): string {
  return s
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
