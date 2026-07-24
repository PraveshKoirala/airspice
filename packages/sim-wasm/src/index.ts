/**
 * sim-wasm public surface (issue #13).
 *
 * The main-thread client + the typed protocol. The WASM engine and eecircuit
 * types are intentionally NOT exported -- they live behind the worker boundary
 * (engine.worker.ts) and never reach consumers (issue guardrail).
 */

export { SimClient, defaultWorkerFactory } from "./client.js";
export type { WorkerFactory } from "./client.js";

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
} from "./protocol.js";

export { classifyStderr, hasError, UNCLASSIFIED_CODE } from "./diagnostics.js";
export { toWaveTables, finalValue } from "./result.js";
export { prepareNetlist } from "./netlist.js";
export {
  CONVERGENCE_LADDER,
  buildRungNetlist,
  runConvergenceLadder,
} from "./ladder.js";
export type { LadderRung, LadderAttempt, LadderOutcome, RungOutcome } from "./ladder.js";

export { CoSimOrchestrator, createSimClientAnalogEngine } from "./cosim.js";
export type {
  PinBinding,
  CoSimStepState,
  CoSimOptions,
  AnalogEngine,
  AnalogSolveInput,
  AnalogSolveOutput,
  FirmwareModel,
  FirmwareStepInput,
  FirmwareStepOutput,
} from "./cosim.js";

