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
} from "agent";
import { simulateDesign } from "./simulate.js";

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
      };
      return out;
    },
    // The stateless server exposes no waveform tool, so nothing is retained and
    // there is nothing to read back. Required by the EngineHooks interface; a
    // non-retaining stub (never an ever-growing cache with no reader).
    readWaveform: () => null,
  };
}
