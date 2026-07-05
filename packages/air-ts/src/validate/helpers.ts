/**
 * Small shared helpers ported from validation.py's private utilities.
 */

/**
 * Port of validation._as_list: coerce a possibly-missing / dict / list value
 * into a list of dicts. `None -> []`, a list keeps only its dict items, a single
 * dict is wrapped, anything else -> []. Used for repeated interface child tags
 * (pullup) and the property list.
 */
export function asList(value: unknown): Array<Record<string, string>> {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, string> => isPlainDict(item));
  }
  if (isPlainDict(value)) return [value];
  return [];
}

/** True for a non-null, non-array object (mirrors Python `isinstance(x, dict)`). */
export function isPlainDict(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Format a Python `f"{x:.<p>g}"` value. Reuses the shared `%.<p>g` formatter so
 * the SOURCE_OVERLOADED / RAIL_LOAD / ADC message numerics match the oracle
 * byte-for-byte (e.g. 0.201 for 0.201A). Kept as a thin re-export point so the
 * validator does not import format internals directly.
 */
export { formatG } from "../format.js";
