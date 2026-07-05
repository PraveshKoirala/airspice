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
import { XmlSecurityError, XmlParseError, decodeXmlBytes } from "./xml.js";
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
      // Security violations (and the SEC-008 invalid-char-ref rejection) carry a
      // registered SEC- code; surface it so the differential harness compares
      // rejection CLASS, not just accept/reject. Non-security parse rejections
      // (bad root, expat not-well-formed) have no dedicated code -> [] (#7).
      const code =
        err instanceof XmlSecurityError
          ? err.code
          : err instanceof XmlParseError
            ? err.code
            : undefined;
      return {
        status: "reject",
        codes: code ? [code] : [],
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
 * Byte-level outcome: enforce the UTF-8-only encoding policy (SEC-007) on raw
 * bytes, then evaluate the decoded text. This is the counterpart the
 * differential fuzzer uses when it feeds raw bytes (e.g. a UTF-16 payload) to
 * both engines -- the oracle reads bytes too, so this keeps the two engines'
 * encoding decision comparable. A non-UTF-8 payload becomes a `reject` carrying
 * SEC-007, never a crash.
 */
export function parseOutcomeBytes(bytes: Uint8Array): ParseOutcome {
  let text: string;
  try {
    text = decodeXmlBytes(bytes);
  } catch (err) {
    if (err instanceof XmlSecurityError) {
      return { status: "reject", codes: [err.code], reason: `${err.name}: ${err.message}` };
    }
    const e = err as Error;
    return { status: "crash", error: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}` };
  }
  return parseOutcome(text);
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
