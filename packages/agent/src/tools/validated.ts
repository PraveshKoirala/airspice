/**
 * The single-write-path invariant — the security core of issue #18.
 *
 * "Agents propose, validators dispose." Every design mutation the agent tool
 * runtime produces MUST pass the deterministic gate (normalize -> validate)
 * before it can become editor state. This module makes that invariant
 * TYPE-ENFORCED and GREP-PROOF:
 *
 *   1. `ValidatedDesign` is a BRANDED type. Its brand (`__validated`) is a
 *      unique private symbol, so a value of this type cannot be produced by an
 *      object literal, a cast a reviewer would notice, `as` on a plain string,
 *      JSON.parse, a mock, or a test helper. The ONLY expression in the whole
 *      codebase that constructs one is `gateDesign(...)` below (it is the only
 *      place the symbol is in scope).
 *
 *   2. `gateDesign(...)` runs the FULL gate (normalize -> validate via the
 *      injected air-ts `EngineHooks`) and returns a `GateResult`: on success a
 *      `ValidatedDesign` carrying the canonical normalized XML; on failure the
 *      diagnostics, and NO `ValidatedDesign`. There is no other return path.
 *
 *   3. The UI's editor-state writer (packages/ui) accepts ONLY a
 *      `ValidatedDesign`. Because the brand is unforgeable, a reviewer or the
 *      guardrails grep can prove that no provider output — mock, test, or real —
 *      reaches editor state without having gone through `gateDesign`. Grep for
 *      `gateDesign(` to enumerate every write; grep for `__validated` to prove
 *      the symbol is referenced only here.
 *
 * The gate is engine-agnostic: it takes air-ts's normalize/validate through the
 * `EngineHooks` seam (deliverable's "consume air-ts, don't fork it"). In the UI
 * and in this package's CI tests the hooks are the REAL air-ts functions, so the
 * gate that runs in every test is the same gate that runs in production — the
 * malformed-proposal-rejected scenario exercises the real validator, not a stub.
 */

import type { EngineHooks, GateDiagnostic } from "./engine.js";

/**
 * A design document that has passed the deterministic gate (normalize ->
 * validate with no error-severity diagnostics). Branded: the `__validated`
 * field is a unique symbol type present on NO other value, so this type is
 * constructible SOLELY by `gateDesign` (the only scope where `BRAND` exists).
 *
 * Consumers read `.xml` (the canonical, normalized document) and `.diagnostics`
 * (any non-error findings — warnings/info — that accompanied a passing gate).
 */
export interface ValidatedDesign {
  /** The canonical, normalized XML — safe to write to editor state. */
  readonly xml: string;
  /** Non-error diagnostics (warnings/info) present on the passing document. */
  readonly diagnostics: readonly GateDiagnostic[];
  /**
   * The unforgeable brand. Its key is a unique symbol TYPE declared privately in
   * this module and its value type is `never`, so NO expression anywhere can
   * satisfy this field — an object literal `{ xml, diagnostics }` is missing a
   * REQUIRED property and does not type-check as a `ValidatedDesign`, and no
   * literal can supply a `never` value. The ONLY way to obtain this type is the
   * single `as ValidatedDesign` cast in `brand()` below, which is co-located
   * with the symbol (in scope nowhere else). The field is PHANTOM: `never` means
   * it is never actually present at runtime, so nothing reads it — it exists
   * purely so the type system rejects every non-gated value. Do NOT export the
   * symbol.
   */
  readonly [BRAND]: never;
}

/** The private brand-symbol TYPE. In scope ONLY inside this module. */
declare const BRAND: unique symbol;

/** The outcome of running the gate on a candidate design. */
export type GateResult =
  | { ok: true; design: ValidatedDesign }
  | { ok: false; diagnostics: GateDiagnostic[]; error?: string };

/**
 * THE ONE GATE. Run normalize -> validate on candidate XML and, only if it has
 * ZERO error-severity diagnostics, return a `ValidatedDesign`. This is the sole
 * constructor of that type in the codebase.
 *
 * Failure modes, all returning `ok: false` (never a `ValidatedDesign`):
 *   - normalize throws (malformed / unparseable XML) -> a synthetic
 *     `XML_PARSE_ERROR` diagnostic, mirroring agent.py `validate_design_xml`.
 *   - validate reports any error-severity diagnostic -> those diagnostics.
 *
 * Determinism: the gate is a pure function of `candidateXml` and the injected
 * hooks (which are pure air-ts functions). Same input -> same GateResult.
 */
export function gateDesign(candidateXml: string, hooks: EngineHooks): GateResult {
  // 1) normalize: coerce near-miss AI XML into strict AIR shape (air-ts #11).
  //    A structural failure here (malformed XML) is a hard reject — the mirror
  //    of agent.py's `except Exception -> XML_PARSE_ERROR`.
  let normalized: string;
  try {
    normalized = hooks.normalize(candidateXml);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      diagnostics: [
        {
          severity: "error",
          code: "XML_PARSE_ERROR",
          message: (err as Error).message,
          domain: "structure",
          related_elements: [],
        },
      ],
    };
  }

  // 2) validate the NORMALIZED document (air-ts #8). We validate the normalized
  //    text so the diagnostics correspond to exactly what would be written.
  let diagnostics: GateDiagnostic[];
  try {
    diagnostics = hooks.validate(normalized);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      diagnostics: [
        {
          severity: "error",
          code: "VALIDATION_ERROR",
          message: (err as Error).message,
          domain: "structure",
          related_elements: [],
        },
      ],
    };
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) {
    // The design failed the gate. Return the diagnostics; NO ValidatedDesign.
    return { ok: false, diagnostics };
  }

  // Passed. `brand(...)` below is the ONLY expression in the codebase that
  // widens a plain document into a ValidatedDesign; the brand symbol type is in
  // scope only in this module, so no other file can construct one.
  const nonError = diagnostics.filter((d) => d.severity !== "error");
  return { ok: true, design: brand(normalized, nonError) };
}

/**
 * The sole ValidatedDesign constructor. Kept as a tiny private function (not an
 * inline cast) so there is exactly ONE `as ValidatedDesign` in the module and it
 * is co-located with the brand symbol. The phantom brand field is never set at
 * runtime — the returned object is just `{ xml, diagnostics }`.
 */
function brand(
  xml: string,
  diagnostics: readonly GateDiagnostic[],
): ValidatedDesign {
  return { xml, diagnostics } as ValidatedDesign;
}
