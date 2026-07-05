/**
 * `dumps` (our port of `json.dumps(obj, indent=2, sort_keys=True) + "\n"`) tests.
 *
 * PROVENANCE: the expected strings below were produced by CPython's json module
 * at authoring time. The load-bearing behaviors are: keys sorted by code point,
 * ensure_ascii=True (non-ASCII and DEL escaped as \uXXXX, astral chars as
 * surrogate pairs), the standard short escapes, `/` left unescaped, empty {}/[]
 * inline, and the two-space indent with ": " / ",\n" separators.
 */

import { describe, it, expect } from "vitest";
import { dumps, type JsonValue } from "../src/json.js";

describe("dumps matches json.dumps(indent=2, sort_keys=True)", () => {
  it("sorts keys by code point (digits < upper < _ < lower)", () => {
    const obj: JsonValue = { B: 1, a: 2, "1": 3, _: 4, A: 5 };
    expect(dumps(obj)).toBe(
      '{\n  "1": 3,\n  "A": 5,\n  "B": 1,\n  "_": 4,\n  "a": 2\n}\n',
    );
  });

  it("escapes non-ASCII (ensure_ascii) and short escapes; leaves / raw", () => {
    const obj: JsonValue = {
      a: 'tab\tnl\nquote"back\\slash',
      b: "café → µ",
      p: "a/b",
    };
    // From CPython: café->é, ->->->, µ->µ.
    expect(dumps(obj)).toBe(
      "{\n" +
        '  "a": "tab\\tnl\\nquote\\"back\\\\slash",\n' +
        '  "b": "caf\\u00e9 \\u2192 \\u00b5",\n' +
        '  "p": "a/b"\n' +
        "}\n",
    );
  });

  it("escapes astral characters as surrogate pairs", () => {
    expect(dumps({ e: "😀" })).toBe('{\n  "e": "\\ud83d\\ude00"\n}\n');
  });

  it("escapes DEL (U+007F) like CPython", () => {
    const del = String.fromCharCode(0x7f);
    expect(dumps({ d: del })).toBe('{\n  "d": "\\u007f"\n}\n');
  });

  it("escapes all control chars below 0x20 with the right forms", () => {
    // \b \t \n \f \r are short escapes; others are \u00xx.
    const controls = String.fromCharCode(0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x00, 0x1f);
    expect(dumps({ c: controls })).toBe(
      '{\n  "c": "\\b\\t\\n\\f\\r\\u0000\\u001f"\n}\n',
    );
  });

  it("renders empty object/array inline and primitives", () => {
    const obj: JsonValue = { e: {}, l: [], n: null, t: true, f: false };
    expect(dumps(obj)).toBe(
      '{\n  "e": {},\n  "f": false,\n  "l": [],\n  "n": null,\n  "t": true\n}\n',
    );
  });

  it("indents nested arrays and objects", () => {
    const obj: JsonValue = { arr: [{ x: 1 }, { y: 2 }], s: [1, 2, 3] };
    expect(dumps(obj)).toBe(
      "{\n" +
        '  "arr": [\n' +
        '    {\n      "x": 1\n    },\n' +
        '    {\n      "y": 2\n    }\n' +
        "  ],\n" +
        '  "s": [\n    1,\n    2,\n    3\n  ]\n' +
        "}\n",
    );
  });

  it("renders integer numbers without a trailing .0", () => {
    expect(dumps({ n: 42 })).toBe('{\n  "n": 42\n}\n');
  });
});
