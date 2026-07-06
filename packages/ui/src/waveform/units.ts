/**
 * Engineering-notation tick + value formatting for the waveform viewer
 * (issue #25 deliverable 3). Reuses air-ts `formatQuantity` for parity with
 * the report JSON (a cursor readout at a sample time reads the SAME string a
 * measurement_stats entry would). Adds a compact tick label form ("1.2m",
 * "3.3k") that fits an axis without the trailing unit.
 */

import { formatQuantity } from "air-ts";

/** Engineering prefixes, ordered by descending magnitude (matches air-ts). */
const PREFIXES: Array<[number, string]> = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1.0, ""],
  [1e-3, "m"],
  [1e-6, "u"],
  [1e-9, "n"],
  [1e-12, "p"],
];

/**
 * Format a value with its unit ("1.234V", "3.30mA") using the air-ts renderer
 * so cursor readouts match the report's `measurement_stats` strings exactly.
 */
export function formatValueUnit(value: number, unit: string): string {
  return formatQuantity(value, unit);
}

/**
 * Compact tick label — engineering notation WITHOUT the unit ("1.2m", "3.3k").
 * Used on axis ticks where the unit is shown once in the axis title.
 */
export function formatTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs < 1e-15) return "0";
  for (const [factor, prefix] of PREFIXES) {
    if (abs >= factor || factor === 1e-12) {
      const scaled = value / factor;
      return `${trimNumber(scaled)}${prefix}`;
    }
  }
  return `${trimNumber(value)}`;
}

/** Format a time value with the "s" unit ("1.20ms", "3.30us"). */
export function formatTime(value: number): string {
  return formatQuantity(value, "s");
}

/**
 * Round a number to at most 3 significant digits, then drop trailing zeros
 * after the decimal point. `1.200` -> `1.2`, `3.000` -> `3`, `1.234` -> `1.23`.
 */
function trimNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(3));
  const asString = String(rounded);
  // Guard against scientific notation for very small values (should not
  // happen post-scaling but the `toPrecision` result CAN be scientific).
  if (asString.includes("e") || asString.includes("E")) {
    return asString;
  }
  if (asString.includes(".")) {
    return asString.replace(/0+$/, "").replace(/\.$/, "");
  }
  return asString;
}

/**
 * "Nice" tick step for an axis spanning `range` units in `pixels` pixels,
 * targeting ~`targetPx` pixels per tick. Rounds to 1/2/5 * 10^k so ticks land
 * on human-readable values.
 */
export function niceTickStep(range: number, pixels: number, targetPx = 80): number {
  if (range <= 0 || pixels <= 0) return 1;
  const rawStep = (range / pixels) * targetPx;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / magnitude;
  let mult: number;
  if (norm < 1.5) mult = 1;
  else if (norm < 3.5) mult = 2;
  else if (norm < 7.5) mult = 5;
  else mult = 10;
  return mult * magnitude;
}

/** Enumerate tick positions covering `[lo, hi]` at multiples of `step`. */
export function tickPositions(lo: number, hi: number, step: number): number[] {
  if (step <= 0 || !Number.isFinite(step)) return [];
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  // Cap the count to guard against a runaway `hi - lo` (e.g. mid-drag rubber
  // band); the axis never legitimately needs more than a few dozen ticks.
  for (let t = first, n = 0; t <= hi && n < 64; t += step, n++) {
    // Snap to zero for a value that is within 0.5*step of zero (float grit).
    out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  }
  return out;
}
