/**
 * Benchmark EngineHooks (issue #19 deliverable 3).
 *
 * The scored loop consumes the engine through the EngineHooks seam, so the
 * benchmark supplies the REAL air-ts gate (normalize → validate → applyPatch →
 * previewPatch → registry) plus a deterministic `simulate`. Only `simulate`
 * differs from production (a real WASM run is browser-only), and it returns the
 * #14 report SHAPE so the loop's report-reading (failing assertions, the #45
 * convergence section) is exercised end to end.
 *
 * The air-ts facade is INJECTED rather than imported here so the SAME engine
 * module serves both runners: the CI vitest test resolves `air-ts` via the
 * Vitest alias and passes those functions in; the standalone CLI imports air-ts
 * by relative source path and passes those. The gate that runs is the real one
 * in both.
 *
 * DETERMINISTIC SIMULATE: the pass/fail signal for these ERC-style cases comes
 * from validation (all six failing examples fail an ERC rule, not a numeric
 * assertion), so the bench simulate reports `passed` for any design that
 * validates clean — the loop only reaches simulate AFTER validation passes, and
 * a validated ERC design has no failing assertion to model. It is a faithful
 * stand-in: a design the gate accepts is one whose constraints hold. (A live
 * run against a real design with a post-sim assertion would exercise the
 * assertion path; that is the live-mode territory.)
 */

import type {
  EngineHooks,
  GateDiagnostic,
  PatchPreviewResult,
  SimulationReportLike,
} from "../src/index.js";

/** The subset of the air-ts facade the bench engine needs (injected). */
export interface AirTsFacade {
  normalize(xml: string): string;
  validate(xml: string): Array<{ severity: string; code: string; message: string; related_elements?: string[]; [k: string]: unknown }>;
  applyPatch(designXml: string, patchXml: string): string;
  previewPatch(
    designXml: string,
    patchXml: string,
  ): {
    success: boolean;
    operations: unknown[];
    resolved: string[];
    introduced: string[];
    before: { errors: number; warnings: number };
    after: { errors: number; warnings: number };
  };
  COMPONENT_SPECS: Record<string, unknown>;
  MCUS: Record<string, unknown>;
}

/** Build the benchmark EngineHooks from an injected air-ts facade. */
export function benchEngine(air: AirTsFacade): EngineHooks {
  return {
    normalize: (xml) => air.normalize(xml),
    validate: (xml) => air.validate(xml) as unknown as GateDiagnostic[],
    applyPatch: (design, patch) => air.applyPatch(design, patch),
    previewPatch: (design, patch) => {
      const p = air.previewPatch(design, patch);
      return {
        success: p.success,
        operations: p.operations,
        resolved: p.resolved,
        introduced: p.introduced,
        before: { errors: p.before.errors, warnings: p.before.warnings },
        after: { errors: p.after.errors, warnings: p.after.warnings },
      } satisfies PatchPreviewResult;
    },
    listRegistry: () => ({
      components: Object.keys(air.COMPONENT_SPECS).sort(),
      mcus: Object.keys(air.MCUS).sort(),
    }),
    simulate: async (xml, signal) => {
      if (signal.aborted) throw new Error("aborted");
      // The loop only simulates a design that already validated (validation
      // gates simulation), so an ERC-clean design passes. Report the #14 shape.
      const errors = air.validate(xml).filter((d) => d.severity === "error");
      const passed = errors.length === 0;
      const report: SimulationReportLike = {
        profile: "analog_only",
        status: passed ? "passed" : "failed",
        reports: [
          {
            test: "bench",
            profile: "analog_only",
            status: passed ? "passed" : "failed",
            backend: "builtin_dc_fallback",
            convergence: {
              attempts: [{ rung: 1, name: "as-written", options: [], converged: passed }],
              converged: passed,
              rung: passed ? 1 : null,
              aids_required: false,
              terminal: false,
              note: null,
            },
            measurements: {},
            diagnostics: [],
          },
        ],
        notes: [],
        runId: "bench-run",
      };
      return report;
    },
    readWaveform: () => null,
  };
}
