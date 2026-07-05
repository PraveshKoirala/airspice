/**
 * Test EngineHooks: the REAL air-ts gate + a deterministic simulate/waveform.
 *
 * The whole point of routing the tool runtime through EngineHooks is that CI can
 * run the SAME gate as production. So `normalize`, `validate`, `applyPatch`,
 * `previewPatch`, and `listRegistry` here are the actual air-ts functions
 * (resolved by the Vitest alias). Only `simulate` and `readWaveform` are
 * deterministic stubs — a real WASM run is manual/browser-only — but they return
 * the #14 report SHAPE so the run_simulation / read_waveform tools are exercised
 * end to end without a worker.
 */

import {
  normalize,
  validate,
  applyPatch,
  previewPatch,
  COMPONENT_SPECS,
  MCUS,
} from "air-ts";
import type {
  EngineHooks,
  GateDiagnostic,
  PatchPreviewResult,
  SimulationReportLike,
  WaveformSummary,
} from "../../src/index.js";

export interface EngineAdapterOptions {
  /** Override the deterministic simulate result (e.g. to assert a failure). */
  simulate?: (xml: string, signal: AbortSignal) => Promise<SimulationReportLike>;
  /** Override the waveform summary source. */
  readWaveform?: (runId: string, net: string, maxPoints: number) => WaveformSummary | null;
}

/** Build EngineHooks backed by real air-ts (gate) + deterministic simulation. */
export function realAirTsEngine(opts: EngineAdapterOptions = {}): EngineHooks {
  return {
    normalize: (xml) => normalize(xml),
    validate: (xml) => validate(xml) as unknown as GateDiagnostic[],
    applyPatch: (design, patch) => applyPatch(design, patch),
    previewPatch: (design, patch) => {
      const p = previewPatch(design, patch);
      return {
        success: p.success,
        operations: p.operations as unknown[],
        resolved: p.resolved,
        introduced: p.introduced,
        before: { errors: p.before.errors, warnings: p.before.warnings },
        after: { errors: p.after.errors, warnings: p.after.warnings },
      } satisfies PatchPreviewResult;
    },
    listRegistry: () => ({
      components: Object.keys(COMPONENT_SPECS).sort(),
      mcus: Object.keys(MCUS).sort(),
    }),
    simulate:
      opts.simulate ??
      (async (_xml, signal) => {
        if (signal.aborted) throw new Error("aborted");
        return {
          profile: "analog_only",
          status: "passed",
          reports: [
            {
              test: "rail_ok",
              profile: "analog_only",
              status: "passed",
              backend: "ngspice",
              measurements: { "v(sense)": "1.65 V" },
              diagnostics: [],
            },
          ],
          notes: [],
          runId: "test-run-1",
        } satisfies SimulationReportLike;
      }),
    readWaveform:
      opts.readWaveform ??
      ((_runId, net, maxPoints) => ({
        net,
        test: "rail_ok",
        totalPoints: 1000,
        returnedPoints: Math.min(maxPoints, 3),
        points: [
          [0, 0],
          [0.005, 1.6],
          [0.01, 1.65],
        ],
        final: 1.65,
        min: 0,
        max: 1.65,
        unit: "V",
      })),
  };
}

/** A slow, abortable simulate that resolves only if not canceled (for Stop). */
export function slowSimulate(delayMs: number): EngineHooks["simulate"] {
  return (_xml, signal) =>
    new Promise<SimulationReportLike>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          profile: "analog_only",
          status: "passed",
          reports: [],
          notes: [],
          runId: "test-run-slow",
        });
      }, delayMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
}
