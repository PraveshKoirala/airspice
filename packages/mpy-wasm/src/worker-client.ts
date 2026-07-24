/**
 * MpyWorkerFirmware — main-thread handle to the mpy-wasm Web Worker.
 *
 * Implements the same {@link FirmwareModel} contract as {@link MpyFirmwareRuntime},
 * but its `step()` is ASYNC (it round-trips to the worker). Because
 * FirmwareModel.step permits `Promise<FirmwareStepOutput>`, this too is drop-in
 * for CoSimOrchestrator — the orchestrator already `await`s each step. Use this
 * in the browser to keep the WASM off the main thread; use MpyFirmwareRuntime
 * directly (sync step) in Node/tests.
 *
 * A `WorkerFactory` is injected so the transport is testable and bundler-choice
 * is the caller's (they build the worker URL). Requests are serialized: one
 * pending reply at a time, matched by monotonic id.
 */

import type {
  FirmwareModel,
  FirmwareStepInput,
  FirmwareStepOutput,
  MpyPinBinding,
} from "./types.js";
import type { WorkerInbound, WorkerOutbound } from "./protocol.js";

/** Minimal Web Worker surface this client needs. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (ev: { data: WorkerOutbound }) => void,
  ): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

interface Pending {
  resolve: (out: FirmwareStepOutput) => void;
  reject: (err: Error) => void;
  kind: "init" | "step";
}

export class MpyWorkerFirmware implements FirmwareModel {
  private readonly worker: WorkerLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(factory: WorkerFactory) {
    this.worker = factory();
    this.worker.addEventListener("message", (ev) => this.onMessage(ev.data));
  }

  private onMessage(msg: WorkerOutbound): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") {
      p.reject(new Error(msg.message));
    } else if (msg.type === "init:ok") {
      p.resolve({});
    } else {
      p.resolve(msg.output);
    }
  }

  private send(
    msg: WorkerInbound,
    kind: "init" | "step",
  ): Promise<FirmwareStepOutput> {
    return new Promise<FirmwareStepOutput>((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject, kind });
      this.worker.postMessage(msg);
    });
  }

  /** Load MicroPython + firmware in the worker. `wasmUrl` is bundler-resolved. */
  async init(
    firmwareSource: string,
    wasmUrl: string,
    bindings?: readonly MpyPinBinding[],
    stepMs?: number,
  ): Promise<void> {
    const id = this.nextId++;
    const req: WorkerInbound = {
      type: "init",
      id,
      firmwareSource,
      wasmUrl,
      ...(bindings ? { bindings } : {}),
      ...(stepMs !== undefined ? { stepMs } : {}),
    };
    await this.send(req, "init");
  }

  /** One firmware step, executed by the real MicroPython in the worker. */
  async step(input: FirmwareStepInput): Promise<FirmwareStepOutput> {
    const id = this.nextId++;
    return this.send({ type: "step", id, input }, "step");
  }

  /** Tear down the worker (kills the WASM instance with it). */
  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) {
      p.reject(new Error("worker terminated"));
    }
    this.pending.clear();
  }
}
