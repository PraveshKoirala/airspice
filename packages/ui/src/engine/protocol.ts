/**
 * Wire protocol shared between the engine facade (main thread) and the air-ts
 * Web Worker (issue #10). A hand-rolled, fully-typed request/response RPC --
 * deliberately NOT Comlink, so the local engine adds ZERO new runtime
 * dependency to the UI bundle beyond air-ts itself (and air-ts's own
 * fast-xml-parser). See engine/README rationale in the PR.
 *
 * Every request carries a monotonic `id`; the worker echoes it so the facade
 * can settle the matching promise. One method per engine capability the UI
 * needs today: `toGraph` (schematic) and `validate` (diagnostics). Simulation
 * and patch application are #14/#11's job -- the facade exposes them as
 * throwing stubs and they are NOT part of this protocol.
 */

import type { GraphData, DiagnosticsPayload } from "./types";

/** Method names the worker understands. */
export type EngineMethod = "toGraph" | "validate";

/** A request from the main thread to the worker. */
export interface EngineRequest {
  id: number;
  method: EngineMethod;
  /** The AIR XML source to operate on. */
  xml: string;
}

/** Discriminated result payloads, keyed by method. */
export interface EngineResultMap {
  toGraph: GraphData;
  validate: DiagnosticsPayload;
}

/** A successful response. */
export interface EngineResponseOk {
  id: number;
  ok: true;
  result: GraphData | DiagnosticsPayload;
}

/** A failed response (the worker caught a parse/validation throw). */
export interface EngineResponseErr {
  id: number;
  ok: false;
  error: string;
}

export type EngineResponse = EngineResponseOk | EngineResponseErr;
