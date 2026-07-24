/**
 * mpy-wasm (issue #37) — real MicroPython WASM firmware runtime with a
 * deterministic virtual clock, exposing a FirmwareModel-compatible step() for
 * #38's CoSimOrchestrator.
 *
 * Root entry is browser-safe: it pulls in NO `node:*` modules. The Node loader
 * lives behind the `mpy-wasm/node` subpath (see src/node/index.ts) so Node APIs
 * never enter a browser bundle; the browser worker is the `mpy-wasm/worker`
 * subpath (src/runtime.worker.ts).
 */

export { MpyFirmwareRuntime } from "./runtime.js";
export { MachineBridge } from "./machine.js";
export { browserMicroPythonLoader } from "./loader-browser.js";
export { MpyWorkerFirmware } from "./worker-client.js";
export type { WorkerLike, WorkerFactory } from "./worker-client.js";

export type {
  FirmwareModel,
  FirmwareStepInput,
  FirmwareStepOutput,
  MpyPinBinding,
  MpyRuntimeOptions,
  MicroPythonInstance,
  MicroPythonLoader,
} from "./types.js";

export type {
  WorkerInbound,
  WorkerOutbound,
  WorkerInitRequest,
  WorkerStepRequest,
  WorkerInitOk,
  WorkerStepOk,
  WorkerError,
} from "./protocol.js";
