/**
 * XML entity + whitespace parity with CPython expat (issues #75 and #76).
 *
 * The air-ts XML layer (src/xml.ts, fast-xml-parser backend) must match the
 * oracle's (`xml.etree.ElementTree`, i.e. CPython expat) ACCEPT/REJECT decision
 * and its parsed attribute/text VALUE, byte-for-byte. Two divergence classes:
 *
 *   #75 entities: expat RESOLVES the 5 predefined entities + numeric char refs,
 *        but REJECTS any undefined named entity (&nbsp; &foo;) and malformed
 *        numeric reference syntax (&#xZZ; &#X42;) with a ParseError. FXP with
 *        htmlEntities:true wrongly resolves &nbsp; and leaves &foo;/&#X42;
 *        without error -- so the REJECT tests below FAIL against the pre-fix
 *        parser and pin the fix.
 *
 *   #76 whitespace: expat normalizes ATTRIBUTE-value whitespace at parse time
 *        (a literal TAB / LF / CR / CRLF becomes a single SPACE), and normalizes
 *        line endings in TEXT (\r\n -> \n, lone \r -> \n). FXP does NOT do the
 *        attribute whitespace-to-space step (a literal tab stays a tab, a CRLF
 *        becomes a lone \n, never a space), so the #76 ATTRIBUTE tests below FAIL
 *        against the pre-fix parser. FXP DOES already normalize TEXT line
 *        endings, so the #76 text tests are regression GUARDS (green pre-fix).
 *
 * PROVENANCE: every expectation below was produced by RUNNING the oracle. The
 * accept/reject + parsed-value expectations come from
 * `python -c "import xml.etree.ElementTree as ET; el = ET.fromstring(INPUT); ..."`
 * and the canonical-string expectations come from the SAME air.canonicalizer the
 * golden corpus is generated with:
 * `python -c "from air import canonicalizer; canonicalizer.canonicalize_tree(ET.ElementTree(ET.fromstring(INPUT)))"`.
 * The exact one-liners + outputs are recorded in the PR/task report. Nothing here
 * is assumed; it is transcribed from real expat output. A stub that resolves
 * &nbsp; or keeps a literal tab in an attribute (the current behavior) MUST fail.
 */

import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/index.js";
import { parseXml, attr, elementText, XmlParseError } from "../src/xml.js";
import { discoverDesigns, readText, byteDiff } from "./harness.js";

/** Wrap an inner payload as the text content of a single-root element. */
const textDoc = (inner: string): string => `<r>${inner}</r>`;
/** Wrap a value inside a double-quoted attribute on a single-root element. */
const attrDoc = (value: string): string => `<r a="${value}"/>`;

// ---------------------------------------------------------------------------- #
// #75 -- predefined + numeric entities RESOLVE (oracle: ACCEPT, value shown).
//
// Oracle (ET.fromstring), TEXT:
//   a&amp;b -> 'a&b'   a&lt;b -> 'a<b'   a&gt;b -> 'a>b'
//   a&quot;b -> 'a"b'  a&apos;b -> "a'b" a&#65;b -> 'aAb'  a&#x42;b -> 'aBb'
// Same values inside an attribute value.
// ---------------------------------------------------------------------------- #

interface EntityCase {
  name: string;
  ref: string;
  value: string;
}

const RESOLVE_CASES: EntityCase[] = [
  { name: "amp", ref: "a&amp;b", value: "a&b" },
  { name: "lt", ref: "a&lt;b", value: "a<b" },
  { name: "gt", ref: "a&gt;b", value: "a>b" },
  { name: "quot", ref: "a&quot;b", value: 'a"b' },
  { name: "apos", ref: "a&apos;b", value: "a'b" },
  { name: "dec65", ref: "a&#65;b", value: "aAb" },
  { name: "hex42", ref: "a&#x42;b", value: "aBb" },
];

describe("#75 predefined + numeric entities resolve (oracle parity)", () => {
  for (const c of RESOLVE_CASES) {
    it(`${c.name} resolves in element text -> ${JSON.stringify(c.value)}`, () => {
      const el = parseXml(textDoc(c.ref));
      expect(elementText(el)).toBe(c.value);
    });
    it(`${c.name} resolves in an attribute value -> ${JSON.stringify(c.value)}`, () => {
      const el = parseXml(attrDoc(c.ref));
      expect(attr(el, "a")).toBe(c.value);
    });
  }
});

// ---------------------------------------------------------------------------- #
// #75 -- undefined named entities + malformed numeric refs are REJECTED.
//
// Oracle (ET.fromstring) raises ParseError for each of these, in BOTH text and
// attribute position:
//   &nbsp;  -> "undefined entity"
//   &foo;   -> "undefined entity"
//   &#xZZ;  -> "not well-formed (invalid token)"   (ZZ are not hex digits)
//   &#X42;  -> "not well-formed (invalid token)"   (uppercase X is invalid)
// air-ts must REJECT with XmlParseError (the oracle's refusal path). The pre-fix
// FXP parser resolves &nbsp;, keeps &foo; literally, and resolves &#X42;, so
// every assertion in this block FAILS against the current parser.
// ---------------------------------------------------------------------------- #

const REJECT_REFS: { name: string; ref: string }[] = [
  { name: "nbsp (undefined entity)", ref: "a&nbsp;b" },
  { name: "foo (undefined entity)", ref: "a&foo;b" },
  { name: "hexZZ (malformed numeric)", ref: "a&#xZZ;b" },
  { name: "bigX (malformed numeric)", ref: "a&#X42;b" },
];

describe("#75 undefined/malformed entities are rejected (oracle parity)", () => {
  for (const c of REJECT_REFS) {
    it(`rejects ${c.name} in element text`, () => {
      expect(() => parseXml(textDoc(c.ref))).toThrow(XmlParseError);
    });
    it(`rejects ${c.name} in an attribute value`, () => {
      expect(() => parseXml(attrDoc(c.ref))).toThrow(XmlParseError);
    });
  }

  it("canonicalize() also rejects an undefined entity (shared parse gate)", () => {
    expect(() => canonicalize(textDoc("a&nbsp;b"))).toThrow(XmlParseError);
  });
});

// ---------------------------------------------------------------------------- #
// #76 -- attribute-value whitespace normalization at parse time.
//
// Oracle (ET.fromstring) `.get('a')`:
//   <r a="a<TAB>b"/>       -> 'a b'
//   <r a="a<LF>b"/>        -> 'a b'
//   <r a="a<CR>b"/>        -> 'a b'
//   <r a="a<CR><LF>b"/>    -> 'a b'      (CRLF collapses to ONE space)
//   <r a="a<TAB><LF><CR>b"/> -> 'a   b'  (each ws char -> one space; 3 spaces)
//
// Oracle air.canonicalizer.canonicalize_tree() output (the golden-corpus oracle):
//   <r a="a<TAB>b"/>       -> '<?xml version="1.0" ?>\n<r a="a b"/>\n'
//   <r a="a<CR><LF>b"/>    -> '<?xml version="1.0" ?>\n<r a="a b"/>\n'
//   <r a="a<TAB><LF><CR>b"/> -> '<?xml version="1.0" ?>\n<r a="a   b"/>\n'
//
// FXP keeps the literal control chars, so both the parsed-model and canonical
// assertions FAIL against the current parser.
// ---------------------------------------------------------------------------- #

const XMLDECL = '<?xml version="1.0" ?>';

interface AttrWsCase {
  name: string;
  raw: string; // literal chars placed inside the attribute value
  value: string; // oracle-normalized attribute value
  canonical: string; // oracle canonicalize_tree output
}

const ATTR_WS_CASES: AttrWsCase[] = [
  { name: "tab", raw: "a\tb", value: "a b", canonical: `${XMLDECL}\n<r a="a b"/>\n` },
  { name: "lf", raw: "a\nb", value: "a b", canonical: `${XMLDECL}\n<r a="a b"/>\n` },
  { name: "cr", raw: "a\rb", value: "a b", canonical: `${XMLDECL}\n<r a="a b"/>\n` },
  { name: "crlf", raw: "a\r\nb", value: "a b", canonical: `${XMLDECL}\n<r a="a b"/>\n` },
  {
    name: "tab-lf-cr",
    raw: "a\t\n\rb",
    value: "a   b",
    canonical: `${XMLDECL}\n<r a="a   b"/>\n`,
  },
];

describe("#76 attribute-value whitespace normalizes to spaces (oracle parity)", () => {
  for (const c of ATTR_WS_CASES) {
    it(`${c.name}: parsed attribute value -> ${JSON.stringify(c.value)}`, () => {
      const el = parseXml(attrDoc(c.raw));
      expect(attr(el, "a")).toBe(c.value);
    });
    it(`${c.name}: canonical serialization matches the oracle byte-for-byte`, () => {
      const actual = canonicalize(attrDoc(c.raw));
      const diff = byteDiff(actual, c.canonical, `attr-ws/${c.name}`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------- #
// #76 -- text line-ending normalization at parse time.
//
// Oracle (ET.fromstring) `.text`:
//   <r>a<CR><LF>b</r> -> 'a\nb'
//   <r>a<CR>b</r>     -> 'a\nb'
//   <r>a<CR><CR>b</r> -> 'a\n\nb'
//   <r>a<LF>b</r>     -> 'a\nb'   (LF unchanged)
//   <r>a<TAB>b</r>    -> 'a\tb'   (TAB preserved in text -- text is NOT ws-norm'd)
//
// NB: the current FXP parser ALREADY applies line-ending normalization to TEXT
// (verified: <r>a\r\nb</r> parses to text 'a\nb'), so these parsed-model
// assertions PASS today -- they are REGRESSION GUARDS pinning the oracle contract
// the fix must not disturb, NOT fail-today cases. The genuine #76 gap is the
// ATTRIBUTE whitespace-to-space normalization above, which FXP does not do.
// ---------------------------------------------------------------------------- #

const TEXT_LE_CASES: { name: string; raw: string; text: string }[] = [
  { name: "crlf -> lf", raw: "a\r\nb", text: "a\nb" },
  { name: "lone cr -> lf", raw: "a\rb", text: "a\nb" },
  { name: "double cr -> double lf", raw: "a\r\rb", text: "a\n\nb" },
  { name: "lf unchanged", raw: "a\nb", text: "a\nb" },
  { name: "tab preserved in text", raw: "a\tb", text: "a\tb" },
];

describe("#76 text line endings normalize (oracle parity)", () => {
  for (const c of TEXT_LE_CASES) {
    it(`${c.name}: parsed .text -> ${JSON.stringify(c.text)}`, () => {
      const el = parseXml(textDoc(c.raw));
      expect(elementText(el)).toBe(c.text);
    });
  }

  // Canonical parity for text CR is asserted on a NON-root element. A root
  // element's direct text is dropped by canonicalizeTree (it mirrors Python's
  // `root[:] = ordered`, which replaces child ELEMENTS while ET preserves
  // root.text via `.text`; air-ts models text as a child node, so root text
  // vanishes -- an unrelated container-only behavior, not #76). Nesting the text
  // one level down exercises the CR-normalization path faithfully. This matches
  // the oracle today too (text line endings already normalize), so it is a guard.
  //
  // Oracle canonicalize_tree('<system name="t"><title>a\r\nb</title></system>')
  //   -> '<?xml version="1.0" ?>\n<system name="t">\n  <title>a\nb</title>\n</system>\n'
  const nestedText = (inner: string): string =>
    `<system name="t"><title>${inner}</title></system>`;
  const expectedNested = `${XMLDECL}\n<system name="t">\n  <title>a\nb</title>\n</system>\n`;

  for (const raw of ["a\r\nb", "a\rb"]) {
    it(`nested text ${JSON.stringify(raw)} canonicalizes byte-identically to the oracle`, () => {
      const actual = canonicalize(nestedText(raw));
      const diff = byteDiff(actual, expectedNested, "nested-text/canonical");
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------- #
// Guard -- a normal corpus-style document (no entities / odd whitespace) parses
// and canonicalizes UNCHANGED. This must stay green both before and after the
// fix: the golden corpus contains none of the above edge inputs, so a correct
// oracle-parity fix leaves every corpus canonical byte-identical.
// ---------------------------------------------------------------------------- #

describe("guard: golden corpus canonical is unaffected", () => {
  const designs = discoverDesigns();

  it("discovers the corpus", () => {
    expect(designs.length).toBeGreaterThanOrEqual(1);
  });

  for (const design of designs) {
    it(`${design.name} still canonicalizes byte-identically`, () => {
      const input = readText(design.inputPath);
      const expected = readText(design.canonicalPath);
      const actual = canonicalize(input);
      const diff = byteDiff(actual, expected, `${design.name}/canonical.air.xml`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
