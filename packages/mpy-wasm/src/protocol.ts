/**
 * Message protocol between the main thread and the mpy-wasm Web Worker.
 * Each request carries a monotonic `id`; the worker echoes it so the client can
 * match replies to pending promises (init and steps are strictly serialized).
 */

import type {
  FirmwareStepInput,
  FirmwareStepOutput,
  MpyPinBinding,
} from "./types.js";

export interface WorkerInitRequest {
  type: "init";
  id: number;
  firmwareSource: string;
  bindings?: readonly MpyPinBinding[];
  stepMs?: number;
  /** Bundler-resolved URL of micropython.wasm (see browserMicroPythonLoader). */
  wasmUrl: string;
}

export interface WorkerStepRequest {
  type: "step";
  id: number;
  input: FirmwareStepInput;
}

export type WorkerInbound = WorkerInitRequest | WorkerStepRequest;

export interface WorkerInitOk {
  type: "init:ok";
  id: number;
}

export interface WorkerStepOk {
  type: "step:ok";
  id: number;
  output: FirmwareStepOutput;
}

export interface WorkerError {
  type: "error";
  id: number;
  message: string;
}

export type WorkerOutbound = WorkerInitOk | WorkerStepOk | WorkerError;
