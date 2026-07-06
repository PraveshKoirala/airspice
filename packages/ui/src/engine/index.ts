/**
 * The UI engine facade (issue #10 deliverable 2; epic #6 requirement 5).
 *
 * ONE entry point the rest of the UI imports -- `getEngine()` returns an
 * `AirEngine` that exposes `toGraph()` / `validate()` (and typed-but-throwing
 * `simulate()` / `applyPatch()` stubs for #14 / #11). Which implementation backs
 * it is chosen ONCE, at build time, by the `VITE_ENGINE` env:
 *
 *   VITE_ENGINE=local   -> air-ts in a Web Worker (zero backend, computed in
 *                          the browser). The browser-first demo of the TS
 *                          engine, selectable in dev via `VITE_ENGINE=local`.
 *   VITE_ENGINE=server  -> the existing FastAPI backend over axios. This is the
 *                          DEFAULT (unset === "server") until M2, so nothing
 *                          changes for existing users until we flip it.
 *
 * Build-time tree-shaking (issue #86): the `./adapter` import below is a
 * SEAM. `vite.config.ts` `resolve.alias` swaps it for `./adapter.local` or
 * `./adapter.server` based on `VITE_ENGINE` when the build runs. That means
 * only ONE adapter's static-import graph enters the bundle -- server-mode
 * builds emit no `graph.worker` chunk, no `eecircuit-engine` chunk, no
 * `simulate` chunk (the local pipeline is genuinely eliminated, not just
 * lazy-loaded-then-never-fetched). The runtime dev toggle still works: pick
 * the mode by running the dev/build with `VITE_ENGINE=local` vs
 * `VITE_ENGINE=server`.
 */

import type { AirEngine, EngineMode } from './types';
// `@engine-adapter` is a build-time SEAM (issue #86). vite.config.ts's
// resolve.alias maps this specifier to either `./adapter.local.ts` or
// `./adapter.server.ts` based on the VITE_ENGINE env at build time, so only one
// adapter's transitive static-import graph is bundled.
import { createEngine } from '@engine-adapter';

export type { AirEngine, GraphData, DiagnosticsPayload, Diagnostic, EngineMode, LocalSimulationResult } from './types';
export { NotImplementedError } from './types';
export { getWaveform, getRun } from './waveformStore';
export type { RetainedWaveform, RunWaveforms } from './waveformStore';

/** Resolve the configured engine mode, defaulting to "server". */
export function resolveEngineMode(): EngineMode {
  const raw = (import.meta.env.VITE_ENGINE ?? '').toString().trim().toLowerCase();
  return raw === 'local' ? 'local' : 'server';
}

let singleton: AirEngine | null = null;

/**
 * The process-wide engine singleton. Created on first call so the worker (local
 * mode) is only spun up when the app actually renders the workspace.
 */
export function getEngine(): AirEngine {
  if (singleton) return singleton;
  singleton = createEngine();
  return singleton;
}

/** The mode the active engine runs in (for badges / debug logging). */
export const ENGINE_MODE: EngineMode = resolveEngineMode();
