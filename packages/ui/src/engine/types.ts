/**
 * Engine-facing types shared by the facade, the worker, and the server adapter
 * (issue #10). These describe the payloads the UI consumes, independent of
 * whether they came from air-ts in a Worker (`VITE_ENGINE=local`) or the FastAPI
 * backend (`VITE_ENGINE=server`) -- the whole point of the facade is that the
 * rest of the UI never knows which.
 */

import type { Node, Edge } from 'reactflow';
import type { Diagnostic, ValidationResult } from '../types/api';

/**
 * The schematic-graph payload. Byte-parity with the oracle's `graph.json` lives
 * in air-ts; the UI only needs the two arrays the Schematic tab renders. The
 * arrays are typed as reactflow Node/Edge because Graph.tsx consumes them as
 * such -- the air-ts emitter output is structurally a superset (id/type/data,
 * plus edge source/target/handles), so it flows through unchanged.
 */
export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

/** Validation result the DiagnosticsPanel renders: `{ success, diagnostics }`. */
export type DiagnosticsPayload = ValidationResult;

export type { Diagnostic };

/**
 * The engine facade contract (epic #6 requirement 5: the UI consumes air-ts
 * through ONE facade so the feature flag can swap local/server cleanly).
 *
 * `toGraph` and `validate` are implemented in this issue. `simulate` and
 * `applyPatch` are declared here so the surface is complete and type-checked,
 * but throw `NotImplementedError` until #14 (simulate) and #11 (patch) fill
 * them -- callers that reach for them fail loudly rather than silently.
 */
export interface AirEngine {
  /** Compute the schematic graph for the given AIR XML. */
  toGraph(xml: string): Promise<GraphData>;
  /** Validate the given AIR XML; resolves to `{ success, diagnostics }`. */
  validate(xml: string): Promise<DiagnosticsPayload>;
  /** #14: run a simulation. Throws NotImplementedError today. */
  simulate(xml: string): Promise<never>;
  /** #11: apply a patch. Throws NotImplementedError today. */
  applyPatch(xml: string, patch: string): Promise<never>;
  /** Which engine backs this instance ("local" | "server"). */
  readonly mode: EngineMode;
  /** Release any held resources (e.g. terminate the worker). */
  dispose(): void;
}

export type EngineMode = 'local' | 'server';

/** Raised by the not-yet-ported capabilities so callers fail loudly. */
export class NotImplementedError extends Error {
  constructor(capability: string, issue: string) {
    super(`Engine capability "${capability}" is not implemented yet (see ${issue}).`);
    this.name = 'NotImplementedError';
  }
}
