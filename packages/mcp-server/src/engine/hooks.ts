/**
 * The MCP server's EngineHooks adapter (issue #40) — the Node analogue of
 * `packages/ui/src/agent/engineHooks.ts`.
 *
 * Every method is a THIN pass-through to an air-ts export (#8/#11/#14) or the
 * Node sim wiring (simulate.ts, which itself only sequences air-ts + sim-wasm).
 * The agent tool runtime (#18) forks none of their logic; it consumes this seam.
 * This is the sole place the MCP server touches the engine, and it does so only
 * by delegation — no validation / normalize / patch / registry / simulation
 * algorithm is reimplemented here.
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
import { simulateDesign, retainedRun, type RetainedWaveform } from "./simulate.js";

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
  const lastIdx = n - 1;
  const lastTime = time[lastIdx] ?? lastIdx;
  if (out.length === 0 || out[out.length - 1]![0] !== lastTime) {
    out.push([lastTime, values[lastIdx] as number]);
  }
  return out;
}

/**
 * Build the EngineHooks the agent tool runtime consumes. Pure delegation to
 * air-ts + the Node sim pipeline; constructed once and reused for the process.
 */
export function createMcpEngineHooks(): EngineHooks {
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
      const result = await simulateDesign(xml, signal);
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
      const run = retainedRun(runId);
      if (!run) return null;
      let found: RetainedWaveform | null = null;
      for (const [, wf] of run) {
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
