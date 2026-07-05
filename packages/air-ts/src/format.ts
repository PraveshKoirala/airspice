/**
 * Number formatting that reproduces CPython's `repr(float)` and `"%.6g" % x`
 * byte-for-byte for the value ranges this engine produces.
 *
 * Why this exists: the golden corpus is diffed byte-for-byte against the Python
 * oracle. Any place a float becomes text must match CPython exactly or parity
 * breaks. The typed model dumped to `model.json` happens to be string-bearing
 * (values like `"330k"` stay strings), so `formatNumber` is not exercised by the
 * #7 corpus itself -- but `units.ts` computes real floats, and #9 (SPICE netlist)
 * and #10 (graph) WILL serialize floats. This util is built and tested to spec
 * now so those ports inherit a correct, shared implementation (issue #7 brief).
 *
 * Both JS and CPython use IEEE-754 binary64 and shortest-round-trip digit
 * generation (Grisu/Ryū vs David Gay's dtoa), so the significant digits agree;
 * the differences are purely presentational and handled here:
 *   - CPython `repr` uses scientific notation for |x| >= 1e16 and 0 < |x| < 1e-4;
 *     JS `Number.toString` uses it for |x| >= 1e21 and |x| < 1e-6.
 *   - CPython pads the exponent to two digits with an explicit sign (`1e-07`,
 *     `1e+16`); JS emits `1e-7`, `1e+21` (sign only for negative, no padding).
 *   - CPython `repr` of an integer-valued float keeps a trailing `.0` (`100.0`);
 *     JS drops it (`100`).
 */

/** Reproduce CPython's `repr(x)` for a float `x`. */
export function formatNumber(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";

  // Handle sign explicitly so -0.0 -> "-0.0" like CPython.
  const negative = x < 0 || Object.is(x, -0);
  const body = reprAbs(Math.abs(x));
  return negative ? "-" + body : body;
}

/** repr of a non-negative finite double (sign handled by caller). */
function reprAbs(abs: number): string {
  if (abs === 0) return "0.0";

  // CPython repr switches to exponential outside [1e-4, 1e16).
  // (1e16 itself is exponential: repr(1e16) == '1e+16'.)
  if (abs >= 1e16 || abs < 1e-4) {
    return toPythonExponential(abs);
  }
  return toPythonFixed(abs);
}

/**
 * Fixed-point form in CPython's repr window. JS `toString` already yields the
 * shortest round-tripping decimal here (never exponential for [1e-4, 1e16)),
 * so we only need to ensure a trailing `.0` for integer-valued results.
 */
function toPythonFixed(abs: number): string {
  const s = abs.toString();
  if (s.indexOf(".") === -1 && s.indexOf("e") === -1) {
    return s + ".0";
  }
  return s;
}

/**
 * Exponential form matching CPython: mantissa is the shortest round-tripping
 * significand (no forced `.0`), exponent has an explicit sign and >= 2 digits.
 * Example: 1e-7 -> "1e-07", 1.0000000000000001e-07, 1e+16, 1.23e+21.
 */
function toPythonExponential(abs: number): string {
  // JS toExponential without a fraction-digit count yields the shortest
  // round-tripping mantissa (e.g. (1e-7).toExponential() === "1e-7").
  const raw = abs.toExponential();
  const eIdx = raw.indexOf("e");
  let mantissa = raw.slice(0, eIdx);
  const expPart = raw.slice(eIdx + 1); // like "-7" or "+21"

  // CPython repr does NOT append ".0" to an integer mantissa in exp form
  // (repr(1e-7) == '1e-07', not '1.0e-07'), which matches JS's mantissa here.

  let expSign = "+";
  let expDigits = expPart;
  if (expDigits.startsWith("-")) {
    expSign = "-";
    expDigits = expDigits.slice(1);
  } else if (expDigits.startsWith("+")) {
    expDigits = expDigits.slice(1);
  }
  if (expDigits.length < 2) {
    expDigits = expDigits.padStart(2, "0");
  }
  return `${mantissa}e${expSign}${expDigits}`;
}

/**
 * Reproduce CPython's `"%.6g" % x` (used by units.format_quantity).
 *
 * `%g` with precision p=6: use the shorter of `%e`/`%f` with (p-1) significant
 * digits after choosing the exponent, strip trailing zeros and a bare decimal
 * point, and use scientific form when the decimal exponent < -4 or >= p.
 */
export function formatG6(x: number): string {
  return formatG(x, 6);
}

/** General `%.<precision>g` formatter matching CPython/printf semantics. */
export function formatG(x: number, precision: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const p = precision < 1 ? 1 : precision;

  if (x === 0) {
    // %g of 0 is "0" (sign preserved for -0.0 per C, but Python's format of
    // -0.0 keeps the sign: "%.6g" % -0.0 == "-0"). Object.is distinguishes.
    return Object.is(x, -0) ? "-0" : "0";
  }

  const negative = x < 0;
  const abs = Math.abs(x);

  // Decimal exponent X such that abs = m * 10^X with 1 <= m < 10, using the
  // rounded-to-(p-1)-fraction-digit exponential representation (C's rule:
  // the exponent is taken AFTER rounding the significand to p sig digits).
  const expStr = abs.toExponential(p - 1); // e.g. "1.00000e+6"
  const eIdx = expStr.indexOf("e");
  const exp = parseInt(expStr.slice(eIdx + 1), 10);

  let out: string;
  if (exp < -4 || exp >= p) {
    // Scientific: p-1 digits after the point, then strip trailing zeros.
    let mantissa = expStr.slice(0, eIdx); // already rounded to p-1 fraction digits
    mantissa = stripTrailingZeros(mantissa);
    const expSign = exp < 0 ? "-" : "+";
    let expDigits = Math.abs(exp).toString();
    if (expDigits.length < 2) expDigits = expDigits.padStart(2, "0");
    out = `${mantissa}e${expSign}${expDigits}`;
  } else {
    // Fixed: (p - 1 - exp) digits after the decimal point, then strip zeros.
    const fractionDigits = p - 1 - exp;
    let fixed = abs.toFixed(fractionDigits >= 0 ? fractionDigits : 0);
    fixed = stripTrailingZeros(fixed);
    out = fixed;
  }
  return negative ? "-" + out : out;
}

function stripTrailingZeros(s: string): string {
  if (s.indexOf(".") === -1) return s;
  let t = s.replace(/0+$/, "");
  if (t.endsWith(".")) t = t.slice(0, -1);
  return t;
}
