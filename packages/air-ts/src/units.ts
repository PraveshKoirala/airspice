/**
 * Port of `packages/core/src/air/units.py`.
 *
 * Byte-for-byte parity target: the numeric results of `parseQuantity` are the
 * same IEEE-754 doubles CPython produces (both languages do the same
 * `float * factor` in binary64), and the error message text matches the oracle
 * exactly. `formatQuantity` reproduces the oracle's `"%.6g"`-based rendering.
 *
 * PARITY: the factor table, the regex, the unit-stripping rule, and the two
 * error messages are copied verbatim from units.py. Do not "fix" the `m` vs
 * `meg` ambiguity or the case handling here -- divergence is a bug (#7 brief).
 */

import { formatG6 } from "./format.js";

/**
 * SI/SPICE prefix factors. Note the deliberate collisions with the oracle:
 *   - "m" is milli (1e-3); "M"/"meg"/"Meg"/"MEG" are all mega (1e6).
 *   - "K" and "k" both mean kilo; "g"/"G" both mean giga.
 * The empty prefix "" means unity.
 */
const UNIT_FACTORS: Record<string, number> = {
  "": 1.0,
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  meg: 1e6,
  Meg: 1e6,
  MEG: 1e6,
  g: 1e9,
  G: 1e9,
};

// Mirror of units.py `_NUMBER_RE`. Groups: (1) the numeric literal, (2) the
// trailing alphabetic suffix. Leading/trailing whitespace is tolerated.
const NUMBER_RE =
  /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)\s*$/;

/**
 * Parse a quantity string like "10k", "4.7u", "330k" to a float.
 *
 * When `expectedUnit` is given and the suffix ends with it (case-insensitive),
 * that unit is stripped before the prefix lookup -- e.g. parseQuantity("4.7kohm",
 * "ohm") -> 4700. Raises on an unparseable number or an unknown prefix, with the
 * same message text as the Python oracle (the ORIGINAL value, not the stripped
 * form, appears in the message).
 */
export function parseQuantity(value: string, expectedUnit?: string | null): number {
  const match = NUMBER_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid quantity: ${value}`);
  }
  const number = pyFloat(match[1] as string);
  let suffix = match[2] as string;
  const unit = expectedUnit ? expectedUnit.toLowerCase() : "";
  if (unit && suffix.toLowerCase().endsWith(unit)) {
    suffix = suffix.slice(0, suffix.length - unit.length);
  }
  if (!Object.prototype.hasOwnProperty.call(UNIT_FACTORS, suffix)) {
    throw new Error(`Unsupported unit prefix in quantity: ${value}`);
  }
  return number * (UNIT_FACTORS[suffix] as number);
}

/**
 * Render a float back to a prefixed string, matching units.py `format_quantity`.
 * The prefix ladder and the `< 1e-15 -> "0<unit>"` short-circuit are verbatim.
 */
export function formatQuantity(value: number, unit: string): string {
  const prefixes: Array<[number, string]> = [
    [1e9, "G"],
    [1e6, "Meg"],
    [1e3, "k"],
    [1.0, ""],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
    [1e-12, "p"],
  ];
  if (Math.abs(value) < 1e-15) {
    return `0${unit}`;
  }
  const absValue = Math.abs(value);
  for (const [factor, prefix] of prefixes) {
    if (absValue >= factor || factor === 1e-12) {
      const scaled = value / factor;
      return `${formatG6(scaled)}${prefix}${unit}`;
    }
  }
  return `${formatG6(value)}${unit}`;
}

/**
 * Port of units.py `spice_value`: SPICE reads a trailing "M" as milli, so an
 * AIR "M" (mega) is rewritten to "Meg" -- but ONLY when the whole string ends
 * in "M" (the oracle does a naive `endswith("M")` replace-all of "M").
 */
export function spiceValue(value: string): string {
  return value.endsWith("M") ? value.replace(/M/g, "Meg") : value;
}

/**
 * Parse a numeric literal exactly as Python's `float()` would for the strings
 * `_NUMBER_RE` admits. That grammar is a strict subset of what JS `Number()`
 * accepts, and both back onto IEEE-754 binary64 round-to-nearest, so
 * `Number(s)` reproduces `float(s)` for every admitted string (leading "+",
 * ".5", "5.", "1e-6", etc.). The regex has already rejected everything else.
 */
function pyFloat(s: string): number {
  return Number(s);
}
