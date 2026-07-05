/**
 * A scriptable in-process stand-in for the engine Web Worker, for UNIT-testing
 * SimClient without WASM. It implements the same message contract
 * (WorkerInbound in, WorkerOutbound out) as engine.worker.ts, but its behavior
 * is programmable per-run so tests can drive result/error/cancel paths and the
 * terminate+respawn cancellation model deterministically.
 *
 * It is NOT the real engine and never runs ngspice -- real-engine behavior is
 * covered by the Playwright browser tests. This exists purely to exercise the
 * client's stream/cancel/preload plumbing.
 */

import type {
  EngineCapabilities,
  SimEvent,
  WorkerInbound,
  WorkerOutbound,
} from "../../src/protocol";

type Listener = (ev: { data: WorkerOutbound }) => void;
type ErrListener = (ev: { message: string }) => void;

export interface StubBehavior {
  /** Capabilities to report on preload. */
  capabilities?: EngineCapabilities;
  /**
   * Per-run scripted events. Given the run id, return the events to emit (in
   * order). If it returns a promise, events are emitted after it resolves,
   * modelling an async run (so `cancel` can land mid-run before completion).
   */
  onRun?: (id: string) => SimEvent[] | Promise<SimEvent[]>;
}

const DEFAULT_CAPS: EngineCapabilities = {
  control: false,
  engine: "stub",
  engineVersion: "0.0.0",
  ngspiceVersion: "0",
};

/** Tracks how many stub workers were constructed/terminated (respawn evidence). */
export const stubStats = { created: 0, terminated: 0 };

export class StubWorker {
  private listeners: Listener[] = [];
  private errListeners: ErrListener[] = [];
  terminated = false;
  private readonly behavior: StubBehavior;

  constructor(behavior: StubBehavior) {
    this.behavior = behavior;
    stubStats.created++;
  }

  addEventListener(type: "message" | "error", cb: Listener | ErrListener): void {
    if (type === "message") this.listeners.push(cb as Listener);
    else this.errListeners.push(cb as ErrListener);
  }

  postMessage(msg: WorkerInbound): void {
    if (this.terminated) return;
    switch (msg.kind) {
      case "preload":
        this.emit({
          kind: "ready",
          id: msg.id,
          capabilities: this.behavior.capabilities ?? DEFAULT_CAPS,
        });
        break;
      case "run": {
        const id = msg.request.id;
        const produce = this.behavior.onRun?.(id) ?? [
          { id, type: "result", tables: [] } as SimEvent,
        ];
        Promise.resolve(produce).then((events) => {
          for (const event of events) {
            if (this.terminated) return;
            this.emit({ kind: "event", event });
          }
        });
        break;
      }
      case "cancel":
        this.emit({ kind: "canceled", id: msg.id });
        break;
    }
  }

  terminate(): void {
    this.terminated = true;
    stubStats.terminated++;
  }

  /** Test hook: simulate an uncaught worker error. */
  crash(message: string): void {
    for (const l of this.errListeners) l({ message });
  }

  private emit(msg: WorkerOutbound): void {
    // Deliver asynchronously, like a real worker's message channel.
    queueMicrotask(() => {
      if (this.terminated && msg.kind !== "canceled") return;
      for (const l of this.listeners) l({ data: msg });
    });
  }
}
