/**
 * A JSON serializer that reproduces CPython's
 * `json.dumps(obj, indent=2, sort_keys=True) + "\n"` byte-for-byte.
 *
 * The golden `model.json` (and `diagnostics.json`, `graph.json`, ...) are
 * written by the oracle with exactly those options, so any port that must be
 * byte-equal has to match every formatting decision CPython's encoder makes.
 * `JSON.stringify` differs in three ways we correct here:
 *   1. It does not sort object keys. CPython sorts by code point; JS string
 *      comparison over BMP code units is the same order, and we sort with it.
 *   2. It does not escape non-ASCII. CPython defaults to ensure_ascii=True,
 *      emitting `\uXXXX` (lowercase hex) and surrogate pairs for astral chars.
 *      DEL (U+007F) is also escaped by CPython; JS keeps it raw.
 *   3. Its indent/separator details differ slightly from `indent=2`.
 *
 * Only the value kinds the typed model uses are supported: string, number,
 * boolean, null, plain object, Map, array. (`number` is included for #9/#10
 * reuse; it is rendered with formatNumber to match CPython's float repr, and
 * integers are rendered as plain integers.)
 *
 * Map<string, JsonValue> is serialized exactly like an object (keys sorted by
 * code point). The model layer uses Maps for its dict-mirroring collections
 * because plain JS objects iterate integer-like keys ("1", "2", "10") in
 * ascending numeric order rather than insertion order -- a divergence from
 * Python dicts that is invisible here (sort_keys) but observable wherever
 * document-order iteration matters (issue #8 rework: validation emission
 * order). Supporting Map in the one serializer keeps that fix out of every
 * call site.
 */

import { formatNumber } from "./format.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
  | Map<string, JsonValue>;

/** Serialize like `json.dumps(obj, indent=2, sort_keys=True) + "\n"`. */
export function dumps(obj: JsonValue): string {
  return encodeValue(obj, 0) + "\n";
}

function encodeValue(value: JsonValue, depth: number): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return encodeString(value as string);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return encodeNumber(value as number);
  if (Array.isArray(value)) return encodeArray(value, depth);
  if (value instanceof Map) return encodeMap(value, depth);
  if (t === "object") return encodeObject(value as Record<string, JsonValue>, depth);
  // Should be unreachable for JsonValue inputs.
  throw new TypeError(`Cannot serialize value of type ${t}`);
}

function encodeNumber(n: number): string {
  if (Number.isInteger(n) && Object.is(n, Math.trunc(n)) && !Object.is(n, -0)) {
    // CPython renders an int-valued int as a bare integer; but our model never
    // stores ints as floats. A genuine JS integer prints without ".0".
    return String(n);
  }
  // Float: CPython uses repr(). NaN/Infinity would emit NaN/Infinity in
  // json.dumps (non-standard); the model never contains them, so formatNumber's
  // "nan"/"inf" are acceptable placeholders and unreachable in practice.
  return formatNumber(n);
}

function encodeArray(arr: JsonValue[], depth: number): string {
  if (arr.length === 0) return "[]";
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  const parts = arr.map((item) => inner + encodeValue(item, depth + 1));
  return "[\n" + parts.join(",\n") + "\n" + outer + "]";
}

function encodeObject(obj: Record<string, JsonValue>, depth: number): string {
  const keys = Object.keys(obj).sort(compareCodeUnits);
  if (keys.length === 0) return "{}";
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  const parts = keys.map(
    (k) =>
      inner +
      encodeString(k) +
      ": " +
      encodeValue(obj[k] as JsonValue, depth + 1),
  );
  return "{\n" + parts.join(",\n") + "\n" + outer + "}";
}

/** A Map serializes exactly like an object: keys sorted by code point. */
function encodeMap(map: Map<string, JsonValue>, depth: number): string {
  const keys = [...map.keys()].sort(compareCodeUnits);
  if (keys.length === 0) return "{}";
  const inner = "  ".repeat(depth + 1);
  const outer = "  ".repeat(depth);
  const parts = keys.map(
    (k) =>
      inner +
      encodeString(k) +
      ": " +
      encodeValue(map.get(k) as JsonValue, depth + 1),
  );
  return "{\n" + parts.join(",\n") + "\n" + outer + "}";
}

/** CPython sorts keys by Unicode code point; BMP code-unit order matches. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Reproduce CPython's `py_encode_basestring_ascii`:
 *   - short escapes for \b \t \n \f \r \" \\
 *   - every other char with code point < 0x20 OR >= 0x7f as \uXXXX
 *     (lowercase hex), astral chars as a UTF-16 surrogate pair (which is exactly
 *     how JS iterates code units, so we emit them directly).
 *   - printable ASCII (0x20..0x7e) verbatim, except " and \.
 */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      default:
        if (code < 0x20 || code >= 0x7f) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}
