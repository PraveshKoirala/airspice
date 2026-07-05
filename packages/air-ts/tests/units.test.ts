/**
 * Units port table test (issue #7 acceptance criterion: "Unit-parse table test
 * covering every suffix units.py supports, values asserted against
 * Python-computed constants").
 *
 * PROVENANCE: every expected number/string below was produced by RUNNING the
 * Python oracle `air.units` (packages/core/src/air/units.py) via the generator
 * scripts/consulted at authoring time. Expected floats are given as their Python
 * `repr()` strings; `Number(repr)` reconstructs the exact IEEE-754 double, so
 * `parseQuantity` (which does the same `float * factor` in binary64) must equal
 * it exactly -- including deliberate float noise like `100n` ->
 * 1.0000000000000001e-07 and `700mA` -> 0.7000000000000001.
 *
 * The table covers every suffix in `_UNIT_FACTORS`: "" f p n u m k K M meg Meg
 * MEG g G -- and the `meg` vs `m` distinction the issue calls out explicitly.
 */

import { describe, it, expect } from "vitest";
import {
  parseQuantity,
  formatQuantity,
  spiceValue,
} from "../src/units.js";

/** Reconstruct the exact double from a Python repr string. */
const D = (repr: string): number => Number(repr);

// --- parseQuantity: every suffix + representative values -------------------- #
// [input, python_repr_of_result]
const PARSE_OK: Array<[string, string]> = [
  ["1", "1.0"],
  ["1f", "1e-15"],
  ["1p", "1e-12"],
  ["1n", "1e-09"],
  ["1u", "1e-06"],
  ["1m", "0.001"], // milli -- NOT mega
  ["1k", "1000.0"],
  ["1K", "1000.0"],
  ["1M", "1000000.0"], // mega
  ["1meg", "1000000.0"],
  ["1Meg", "1000000.0"],
  ["1MEG", "1000000.0"],
  ["1g", "1000000000.0"],
  ["1G", "1000000000.0"],
  ["10k", "10000.0"],
  ["4.7u", "4.7e-06"],
  ["100n", "1.0000000000000001e-07"], // float noise preserved
  ["330k", "330000.0"],
  ["0.5", "0.5"],
  [".5", "0.5"],
  ["5.", "5.0"],
  ["+2.5k", "2500.0"],
  ["-1.5m", "-0.0015"],
  ["2.2e3", "2200.0"],
  ["1E-6", "1e-06"],
  ["  10k  ", "10000.0"],
  ["1.0", "1.0"],
  ["0", "0.0"],
  ["0.0", "0.0"],
  ["1e10", "10000000000.0"],
  ["2.5G", "2500000000.0"],
];

describe("parseQuantity: suffix table (oracle-computed)", () => {
  for (const [input, repr] of PARSE_OK) {
    it(`parseQuantity(${JSON.stringify(input)}) === ${repr}`, () => {
      expect(parseQuantity(input)).toBe(D(repr));
    });
  }

  it("meg and m are distinct (mega vs milli)", () => {
    expect(parseQuantity("1meg")).toBe(1e6);
    expect(parseQuantity("1m")).toBe(1e-3);
    expect(parseQuantity("1M")).toBe(1e6);
  });
});

// --- parseQuantity with an expectedUnit ------------------------------------- #
const PARSE_UNIT: Array<[string, string, string]> = [
  ["3.3V", "V", "3.3"],
  ["700mA", "A", "0.7000000000000001"], // float noise preserved
  ["100nF", "F", "1.0000000000000001e-07"],
  ["10k", "ohm", "10000.0"],
  ["4.7kohm", "ohm", "4700.0"],
  ["5s", "s", "5.0"],
];

describe("parseQuantity: expected-unit stripping (oracle-computed)", () => {
  for (const [input, unit, repr] of PARSE_UNIT) {
    it(`parseQuantity(${JSON.stringify(input)}, ${JSON.stringify(unit)}) === ${repr}`, () => {
      expect(parseQuantity(input, unit)).toBe(D(repr));
    });
  }
});

// --- parseQuantity errors (message text is part of parity) ------------------ #
const PARSE_ERR: Array<[string, string]> = [
  ["", "Invalid quantity: "],
  ["abc", "Invalid quantity: abc"],
  ["10x", "Unsupported unit prefix in quantity: 10x"],
  ["1.2.3", "Invalid quantity: 1.2.3"],
  ["k10", "Invalid quantity: k10"],
  ["1 k 2", "Invalid quantity: 1 k 2"],
  ["1kk", "Unsupported unit prefix in quantity: 1kk"],
  ["meg", "Invalid quantity: meg"],
  ["  ", "Invalid quantity:   "],
  ["1megx", "Unsupported unit prefix in quantity: 1megx"],
  ["3.3V", "Unsupported unit prefix in quantity: 3.3V"], // no expected unit
  ["3v3", "Invalid quantity: 3v3"],
  ["100nF", "Unsupported unit prefix in quantity: 100nF"],
];

describe("parseQuantity: error messages match the oracle", () => {
  for (const [input, message] of PARSE_ERR) {
    it(`parseQuantity(${JSON.stringify(input)}) throws ${JSON.stringify(message)}`, () => {
      expect(() => parseQuantity(input)).toThrowError(message);
    });
  }
});

// --- formatQuantity (oracle-computed) --------------------------------------- #
const FORMAT: Array<[string, string, string]> = [
  ["0.0", "V", "0V"],
  ["1e-16", "V", "0V"],
  ["1500.0", "ohm", "1.5kohm"],
  ["4700.0", "ohm", "4.7kohm"],
  ["0.0047", "F", "4.7mF"],
  ["1e-09", "F", "1nF"],
  ["2500000.0", "ohm", "2.5Megohm"],
  ["3.3", "V", "3.3V"],
  ["1000000000.0", "Hz", "1GHz"],
  ["1e-12", "F", "1pF"],
  ["5e-13", "F", "0.5pF"],
  ["-1500.0", "A", "-1.5kA"],
  ["123456.0", "ohm", "123.456kohm"],
  ["999.0", "V", "999V"],
  ["1.0", "", "1"],
];

describe("formatQuantity (oracle-computed)", () => {
  for (const [valueRepr, unit, result] of FORMAT) {
    it(`formatQuantity(${valueRepr}, ${JSON.stringify(unit)}) === ${JSON.stringify(result)}`, () => {
      expect(formatQuantity(D(valueRepr), unit)).toBe(result);
    });
  }
});

// --- spiceValue (oracle-computed) ------------------------------------------- #
const SPICE: Array<[string, string]> = [
  ["10M", "10Meg"],
  ["10Meg", "10Meg"],
  ["10k", "10k"],
  ["1M", "1Meg"],
  ["M", "Meg"],
  ["3.3", "3.3"],
  ["MM", "MegMeg"], // Python replaces ALL "M" when the string ends in "M"
  ["aM", "aMeg"],
];

describe("spiceValue (oracle-computed)", () => {
  for (const [input, result] of SPICE) {
    it(`spiceValue(${JSON.stringify(input)}) === ${JSON.stringify(result)}`, () => {
      expect(spiceValue(input)).toBe(result);
    });
  }
});
