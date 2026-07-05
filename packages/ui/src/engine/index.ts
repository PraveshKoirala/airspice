/**
 * The UI engine facade (issue #10 deliverable 2; epic #6 requirement 5).
 *
 * ONE entry point the rest of the UI imports -- `getEngine()` returns an
 * `AirEngine` that exposes `toGraph()` / `validate()` (and typed-but-throwing
 * `simulate()` / `applyPatch()` stubs for #14 / #11). Which implementation backs
 * it is chosen ONCE, at module load, by the `VITE_ENGINE` build-time env:
 *
 *   VITE_ENGINE=local   -> air-ts in a Web Worker (zero backend, computed in
 *                          the browser). Selectable in dev; the browser-first
 *                          demo of the TS engine.
 *   VITE_ENGINE=server  -> the existing FastAPI backend over axios. This is the
 *                          DEFAULT (unset === "server") until M2, so nothing
 *                          changes for existing users until we flip it.
 *
 * The selection is deliberately a build-time constant (not runtime-switchable):
 * it lets Vite tree-shake the unused adapter out of the production bundle.
 */

import type { AirEngine, EngineMode } from './types';
import { createLocalEngine } from './local';
import { createServerEngine } from './server';

export type { AirEngine, GraphData, DiagnosticsPayload, Diagnostic, EngineMode } from './types';
export { NotImplementedError } from './types';

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
  singleton = resolveEngineMode() === 'local' ? createLocalEngine() : createServerEngine();
  return singleton;
}

/** The mode the active engine runs in (for badges / debug logging). */
export const ENGINE_MODE: EngineMode = resolveEngineMode();
