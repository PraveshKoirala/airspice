/**
 * ElementTree `ET.tostring(el, encoding="unicode")` serialization, byte-exact.
 *
 * PARITY: this is a SEPARATE serializer from the canonicalizer (canonicalizer.ts).
 * The oracle's `patch_operations` (patches.py:54) serializes each op's payload
 * element with `ET.tostring(child, encoding="unicode")`, which is CPython's raw
 * ElementTree serializer -- NOT the minidom pretty-printer the canonicalizer
 * mimics. The two differ in ways that matter for byte parity:
 *   - attributes keep DOCUMENT (insertion) order, they are NOT sorted;
 *   - an element with no children self-closes as `<tag ... />` -- a SPACE before
 *     `/>` (minidom/canonicalizer emit `<tag/>` with no space);
 *   - `ET.tostring` INCLUDES the element's `.tail` (the text after its close tag
 *     but inside its parent). For a patch payload that is the whitespace/newline
 *     between the payload element and the closing `</replace>`/`</add>` tag, so
 *     the observed payload string is e.g. `"<value>1M</value>\n  "`.
 *
 * Text/attribute escaping mirrors CPython's ElementTree (`_escape_cdata` /
 * `_escape_attrib`), captured from the live oracle:
 *   - text: `&`->`&amp;`  `<`->`&lt;`  `>`->`&gt;`  (quotes stay literal)
 *   - attr: `&`->`&amp;`  `<`->`&lt;`  `>`->`&gt;`  `"`->`&quot;`
 *           plus whitespace char refs `\t`->`&#09;` `\n`->`&#10;` `\r`->`&#13;`
 *     (ElementTree escapes tab/newline/CR in ATTRIBUTE values as char refs so a
 *     re-parse preserves them; text keeps `\r`/`\n`/`\t` literal). Single quotes
 *     are never escaped (ElementTree always quotes attributes with `"`).
 *
 * The tail is handled by `nodeToString` (the entry point used by
 * patch_operations): it serializes the element and then appends its tail. Our
 * XmlElement model stores an element's tail as the leading text run(s) of the
 * NEXT sibling / as trailing text in the parent's children list, so the tail is
 * threaded through explicitly by the caller (see patch/index.ts firstElementChild
 * + tailOf).
 */

import type { XmlElement, XmlNode } from "../xml.js";

/**
 * Serialize a single element exactly as `ET.tostring(el, encoding="unicode")`
 * WITHOUT its tail. Children (elements and text runs) are emitted in document
 * order; text runs are escaped as character data.
 */
export function elementToString(el: XmlElement): string {
  const parts: string[] = [];
  writeElement(el, parts);
  return parts.join("");
}

function writeElement(el: XmlElement, out: string[]): void {
  out.push("<");
  out.push(el.tag);
  for (const [k, v] of el.attrib) {
    out.push(" ");
    out.push(k);
    out.push('="');
    out.push(escapeAttrib(v));
    out.push('"');
  }
  // ElementTree self-closes an element with NO children as `<tag ... />` (note
  // the space). "No children" means no element children AND no text: an empty
  // `text` (None) and no sub-elements. In our model that is an empty children
  // list. A text-only element is NOT self-closed.
  if (el.children.length === 0) {
    out.push(" />");
    return;
  }
  out.push(">");
  for (const child of el.children) {
    if (child.kind === "element") {
      writeElement(child, out);
      // ElementTree writes each child's `.tail` AFTER the child's close tag.
      // In our interleaved model the child's tail is represented by the text
      // run(s) that immediately follow it in `children`, which we emit in the
      // loop below as their own escaped-cdata nodes -- so nothing extra here.
    } else {
      out.push(escapeCdata(child.value));
    }
  }
  out.push("</");
  out.push(el.tag);
  out.push(">");
}

/**
 * Serialize an element AND its tail, exactly as `ET.tostring` does when the
 * element is the argument (its tail is included in the output). `tail` is the
 * text that follows the element inside its parent (the payload wrapper).
 */
export function nodeToStringWithTail(el: XmlElement, tail: string): string {
  return elementToString(el) + escapeCdata(tail);
}

/** CPython ElementTree `_escape_cdata`: & < > (quotes/newlines stay literal). */
function escapeCdata(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * CPython ElementTree `_escape_attrib`: & < > " plus \n \t \r as char refs.
 * The order matters (& first). Verified against the live oracle:
 *   ET.tostring on name="a\tb\nc"  ->  name="a&#09;b&#10;c"
 */
function escapeAttrib(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#09;");
}

// Kept for the type checker: XmlNode is the element/text union used above.
export type { XmlNode };
