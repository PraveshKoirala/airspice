/**
 * `formatNumber` (CPython `repr(float)`) and `formatG6` (CPython `"%.6g"`) tests.
 *
 * PROVENANCE: every expected string was produced by running CPython (`repr(x)`
 * and `"%.6g" % x`) at authoring time. The float-repr window boundaries
 * (1e16 up, 1e-4 down), the two-digit signed padded exponent, the trailing `.0`
 * on integer-valued floats, and the sci/fixed switch of `%g` are exactly the
 * decisions that break byte-parity in #9/#10 if wrong, so they are pinned here.
 *
 * Each `repr` expected string is ALSO the JS literal we feed in: `Number(repr)`
 * reconstructs the identical double, so `formatNumber(Number(repr)) === repr`.
 */

import { describe, it, expect } from "vitest";
import { formatNumber, formatG6 } from "../src/format.js";

// Each entry is a CPython repr() string; it round-trips to its own double.
const REPRS: string[] = [
  "0.0",
  "1.0",
  "100.0",
  "1000.0",
  "0.001",
  "0.1",
  "0.5",
  "4.7e-06",
  "1e-09",
  "1e-15",
  "1e+16",
  "1e+17",
  "0.0001",
  "1e-05",
  "1e+21",
  "123456789.0",
  "1234567890123456.0",
  "3.3",
  "2.2",
  "4.7",
  "1e+100",
  "1e-100",
  "1.5e-10",
  "10000000000.0",
  "2500000000.0",
  "1000000.0",
  "1000000000000000.0",
  "9999999999999998.0",
  "0.30000000000000004",
  "5e-324",
  "1.7976931348623157e+308",
  "9.999e-05",
  "1.0000000000000001e-07",
  "0.7000000000000001",
];

describe("formatNumber reproduces CPython repr(float)", () => {
  for (const repr of REPRS) {
    it(`formatNumber(${repr}) === ${JSON.stringify(repr)}`, () => {
      expect(formatNumber(Number(repr))).toBe(repr);
    });
  }

  it("handles signed zero and non-finite values", () => {
    expect(formatNumber(-0)).toBe("-0.0");
    expect(formatNumber(0)).toBe("0.0");
    expect(formatNumber(NaN)).toBe("nan");
    expect(formatNumber(Infinity)).toBe("inf");
    expect(formatNumber(-Infinity)).toBe("-inf");
  });

  it("handles negatives via the sign path", () => {
    expect(formatNumber(-100)).toBe("-100.0");
    expect(formatNumber(-4.7e-6)).toBe("-4.7e-06");
    expect(formatNumber(-1e16)).toBe("-1e+16");
  });
});

// [js-literal-as-repr-string, "%.6g" result]
const G6: Array<[string, string]> = [
  ["123.456", "123.456"],
  ["1.5", "1.5"],
  ["4.7", "4.7"],
  ["1.0", "1"],
  ["0.5", "0.5"],
  ["1234567.0", "1.23457e+06"],
  ["0.0001234567", "0.000123457"],
  ["100.0", "100"],
  ["3.3", "3.3"],
  ["1e-07", "1e-07"],
  ["10000000.0", "1e+07"],
  ["1e-05", "1e-05"],
  ["999999.5", "1e+06"],
  ["1000000.0", "1e+06"],
  ["123456.0", "123456"],
  ["12345678.0", "1.23457e+07"],
  ["2500000.0", "2.5e+06"],
  ["0.0047", "0.0047"],
  ["0.0", "0"],
  ["-1500.0", "-1500"],
  ["-0.5", "-0.5"],
];

describe("formatG6 reproduces CPython '%.6g'", () => {
  for (const [input, result] of G6) {
    it(`formatG6(${input}) === ${JSON.stringify(result)}`, () => {
      expect(formatG6(Number(input))).toBe(result);
    });
  }
});
