/**
 * The UI's EngineHooks adapter (issue #18): wires the agent tool runtime's
 * engine seam to the REAL air-ts facade (#8/#11/#14) and the local zero-backend
 * simulation pipeline (#14) with cancellation (#13).
 *
 * Everything the runtime needs from "the engine" is a thin pass-through to an
 * air-ts export or the engine facade — the runtime forks NONE of their logic
 * (issue guardrail: consume air-ts/sim-wasm, don't rewrite them). `simulate`
 * forwards the Stop/timeout AbortSignal so an in-flight run is canceled (worker
 * terminate + respawn, ADR 0011). `readWaveform` DECIMATES the retained typed
 * arrays to at most `maxPoints` — the model never sees 100k raw samples.
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
} from "agent";
import { getEngine } from "../engine";
import { getRun } from "../engine/waveformStore";

/** Decimate `[time,value]` samples to at most `maxPoints` (stride + keep last). */
function decimate(
  time: Float64Array,
  values: Float64Array,
  maxPoints: number,
): Array<[number, number]> {
  const n = values.length;
  if (n === 0) return [];
  if (n <= maxPoints) {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) out.push([time[i] ?? i, values[i] as number]);
    return out;
  }
  const step = Math.floor(n / maxPoints) || 1;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += step) out.push([time[i] ?? i, values[i] as number]);
  // Always include the true final sample so final/min/max scalars line up.
  const lastIdx = n - 1;
  if (out.length === 0 || out[out.length - 1]![0] !== (time[lastIdx] ?? lastIdx)) {
    out.push([time[lastIdx] ?? lastIdx, values[lastIdx] as number]);
  }
  return out;
}

/**
 * Build the EngineHooks the agent tool runtime consumes. Pure delegation to
 * air-ts + the engine facade; constructed once and reused for a session.
 */
export function createUiEngineHooks(): EngineHooks {
  return {
    normalize: (xml) => normalize(xml),
    validate: (xml) => validate(xml) as unknown as GateDiagnostic[],
    applyPatch: (design, patch) => applyPatch(design, patch),
    previewPatch: (design, patch) => {
      const p = previewPatch(design, patch);
      const result: PatchPreviewResult = {
        success: p.success,
        operations: p.operations as unknown[],
        resolved: p.resolved,
        introduced: p.introduced,
        before: { errors: p.before.errors, warnings: p.before.warnings },
        after: { errors: p.after.errors, warnings: p.after.warnings },
      };
      return result;
    },
    listRegistry: () => ({
      components: Object.keys(COMPONENT_SPECS).sort(),
      mcus: Object.keys(MCUS).sort(),
    }),
    simulate: async (xml, signal) => {
      // The local zero-backend pipeline, cancelable via the Stop/timeout signal.
      const result = await getEngine().simulate(xml, signal);
      const out: SimulationReportLike = {
        profile: result.profile,
        status: result.status,
        reports: result.reports as unknown[],
        notes: result.notes,
        runId: result.runId,
      };
      return out;
    },
    readWaveform: (runId, net, maxPoints) => {
      const run = getRun(runId);
      if (!run) return null;
      // Find the first retained waveform for this net (any test).
      let found: { net: string; test: string; time: Float64Array; values: Float64Array } | null =
        null;
      for (const [, wf] of run.waveforms) {
        if (wf.net === net) {
          found = wf;
          break;
        }
      }
      if (!found) return null;
      const points = decimate(found.time, found.values, maxPoints);
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < found.values.length; i++) {
        const v = found.values[i] as number;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const summary: WaveformSummary = {
        net,
        test: found.test,
        totalPoints: found.values.length,
        returnedPoints: points.length,
        points,
        final: found.values.length ? (found.values[found.values.length - 1] as number) : 0,
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
        unit: "V",
      };
      return summary;
    },
  };
}
