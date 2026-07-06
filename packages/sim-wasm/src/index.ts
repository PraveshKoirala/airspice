/**
 * sim-wasm public surface (issue #13).
 *
 * The main-thread client + the typed protocol. The WASM engine and eecircuit
 * types are intentionally NOT exported -- they live behind the worker boundary
 * (engine.worker.ts) and never reach consumers (issue guardrail).
 */

export { SimClient, defaultWorkerFactory } from "./client";
export type { WorkerFactory } from "./client";

export type {
  ProbeSpec,
  SimRequest,
  SimEvent,
  WaveTable,
  SignalUnit,
  SimDiagnostic,
  SimLadderAttempt,
  SimLadderOutcome,
  EngineCapabilities,
  WorkerInbound,
  WorkerOutbound,
  SimControl,
} from "./protocol";

export { classifyStderr, hasError, UNCLASSIFIED_CODE } from "./diagnostics";
export { toWaveTables, finalValue } from "./result";
export { prepareNetlist } from "./netlist";
export {
  CONVERGENCE_LADDER,
  buildRungNetlist,
  runConvergenceLadder,
} from "./ladder";
export type { LadderRung, LadderAttempt, LadderOutcome, RungOutcome } from "./ladder";
