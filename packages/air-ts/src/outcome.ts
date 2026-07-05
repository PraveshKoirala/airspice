/**
 * Differential-fuzzer-facing outcome reporting (issue #7 post-audit amendment 2,
 * for #43). The fuzzer feeds mutated XML to both this parser and the Python
 * oracle and compares outcomes. To avoid #43 reverse-engineering internals, the
 * parser's outcome is packaged here as a small, stable, three-variant result:
 *
 *   - accept: parsing succeeded; carries a stable hash of the serialized model
 *     (the canonical `model.json` bytes) so two accepts can be compared without
 *     shipping the whole model.
 *   - reject: parsing/validation refused the input; carries diagnostic codes.
 *     (#7 is parse-only: the parser rejects via thrown errors, not diagnostic
 *     codes -- validation codes are #8. `codes` is [] here today and the field
 *     exists so #8 can populate it without changing the shape.)
 *   - crash: an unexpected exception escaped; carries the error name/message.
 *
 * This is intentionally dependency-light and deterministic.
 */

import { parse } from "./index.js";
import { serializeModel } from "./model_dump.js";
import { XmlSecurityError, XmlParseError } from "./xml.js";
import { AirParseError } from "./parser.js";

export type ParseOutcome =
  | { status: "accept"; modelHash: string }
  | { status: "reject"; codes: string[]; reason: string }
  | { status: "crash"; error: string };

/**
 * Run the parser over XML and report a normalized outcome for differential
 * fuzzing. Never throws: expected refusals become `reject`, unexpected failures
 * become `crash`.
 */
export function parseOutcome(xmlText: string): ParseOutcome {
  let modelJson: string;
  try {
    const ir = parse(xmlText);
    modelJson = serializeModel(ir);
  } catch (err) {
    // Expected, structured refusals (bad root, malformed XML, security limits).
    if (
      err instanceof AirParseError ||
      err instanceof XmlParseError ||
      err instanceof XmlSecurityError
    ) {
      return {
        status: "reject",
        codes: [], // parser-level: no diagnostic codes in #7 (see module doc).
        reason: `${err.name}: ${err.message}`,
      };
    }
    // Anything else is a genuine crash the fuzzer should flag.
    const e = err as Error;
    return { status: "crash", error: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}` };
  }
  return { status: "accept", modelHash: fnv1a64(modelJson) };
}

/**
 * FNV-1a 64-bit hash of a string's UTF-8 bytes, hex-encoded. Deterministic,
 * dependency-free, and stable across platforms/engines -- adequate as a model
 * fingerprint for differential comparison (not a security primitive).
 */
export function fnv1a64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  // 64-bit FNV-1a using BigInt for exactness.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i] as number);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
