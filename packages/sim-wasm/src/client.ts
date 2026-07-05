/**
 * sim-wasm main-thread client (issue #13 deliverable 2).
 *
 * `SimClient` owns the Web Worker and exposes the typed API:
 *   - `run(req): AsyncIterable<SimEvent>` -- stream events for one run.
 *   - `cancel(id): void`                  -- interrupt a run (terminate+respawn).
 *   - `preload(): Promise<EngineCapabilities>` -- warm the WASM, learn caps.
 *
 * The WASM engine lives ONLY in the worker; this file never imports it and never
 * runs simulation on the main thread (epic #12 binding decision 1). The client
 * is a thin, fully-typed message pump.
 *
 * CANCELLATION (ADR 0011): eecircuit-engine cannot interrupt an in-flight
 * `runSim`. So `cancel(id)` for the *active* run TERMINATES the worker and spawns
 * a fresh one immediately. This is the only way to guarantee the "canceled run
 * returns quickly and the next run succeeds" acceptance criterion with a
 * fire-and-forget engine. The terminated run's async iterator is settled with a
 * final synthetic `error` event (code SIM-CANCELED) so awaiting consumers unwind
 * cleanly. The respawned worker is pristine -> the engine is usable again.
 */

import type {
  EngineCapabilities,
  SimEvent,
  SimRequest,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol";

/** Factory for the worker. Injectable so tests can supply a stub worker. */
export type WorkerFactory = () => Worker;

/**
 * Default worker factory: constructs the bundled engine worker as an ES module
 * worker. Vite resolves `new URL('./engine.worker.ts', import.meta.url)` +
 * `{ type: 'module' }` into a hashed, code-split worker chunk (which in turn
 * lazy-imports the WASM). Node/Vitest unit tests inject a stub instead.
 */
export function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./engine.worker.ts", import.meta.url), {
    type: "module",
    name: "sim-wasm-engine",
  });
}

interface RunChannel {
  id: string;
  push: (ev: SimEvent) => void;
  end: () => void;
  ended: boolean;
}

export class SimClient {
  private worker: Worker | null = null;
  private readonly factory: WorkerFactory;
  private readonly channels = new Map<string, RunChannel>();
  private preloadWaiters: Array<(caps: EngineCapabilities) => void> = [];
  private preloadRejecters: Array<(err: Error) => void> = [];
  private capabilities: EngineCapabilities | null = null;
  private disposed = false;

  constructor(factory: WorkerFactory = defaultWorkerFactory) {
    this.factory = factory;
  }

  /** Ensure a worker exists and its listeners are wired. */
  private ensureWorker(): Worker {
    if (this.disposed) throw new Error("SimClient has been disposed");
    if (this.worker) return this.worker;
    const w = this.factory();
    w.addEventListener("message", (ev: MessageEvent<WorkerOutbound>) =>
      this.onMessage(ev.data),
    );
    w.addEventListener("error", (ev) => this.onWorkerError(ev));
    this.worker = w;
    return w;
  }

  private send(msg: WorkerInbound): void {
    this.ensureWorker().postMessage(msg);
  }

  private onMessage(msg: WorkerOutbound): void {
    switch (msg.kind) {
      case "ready": {
        this.capabilities = msg.capabilities;
        const waiters = this.preloadWaiters;
        this.preloadWaiters = [];
        this.preloadRejecters = [];
        for (const w of waiters) w(msg.capabilities);
        break;
      }
      case "event": {
        const ch = this.channels.get(msg.event.id);
        if (!ch) break;
        ch.push(msg.event);
        // A terminal event (result/error) ends the run's stream.
        if (msg.event.type === "result" || msg.event.type === "error") {
          this.closeChannel(ch.id);
        }
        break;
      }
      case "canceled": {
        this.closeChannel(msg.id);
        break;
      }
      case "fatal": {
        // Engine failed to start; reject any preload waiters and end all runs.
        const err = new Error(`sim-wasm engine fatal: ${msg.message}`);
        const rejecters = this.preloadRejecters;
        this.preloadWaiters = [];
        this.preloadRejecters = [];
        for (const r of rejecters) r(err);
        for (const id of [...this.channels.keys()]) {
          this.pushError(id, "SIM-ENGINE-FATAL", msg.message);
          this.closeChannel(id);
        }
        break;
      }
    }
  }

  private onWorkerError(ev: ErrorEvent): void {
    // An uncaught worker error kills the engine; surface it to every open run.
    const message = ev.message || "worker crashed";
    for (const id of [...this.channels.keys()]) {
      this.pushError(id, "SIM-WORKER-CRASH", message);
      this.closeChannel(id);
    }
    const rejecters = this.preloadRejecters;
    this.preloadWaiters = [];
    this.preloadRejecters = [];
    for (const r of rejecters) r(new Error(message));
  }

  private pushError(id: string, code: string, raw: string): void {
    const ch = this.channels.get(id);
    if (!ch) return;
    ch.push({
      id,
      type: "error",
      diagnostic: {
        code,
        message: "The simulation was interrupted.",
        hint: "",
        severity: "error",
        raw,
      },
    });
  }

  private closeChannel(id: string): void {
    const ch = this.channels.get(id);
    if (!ch || ch.ended) return;
    ch.ended = true;
    this.channels.delete(id);
    ch.end();
  }

  /**
   * Warm the WASM engine without running a simulation, and resolve with its
   * advertised capabilities. Safe to call repeatedly; the engine loads once.
   */
  preload(): Promise<EngineCapabilities> {
    if (this.capabilities) return Promise.resolve(this.capabilities);
    return new Promise<EngineCapabilities>((resolve, reject) => {
      this.preloadWaiters.push(resolve);
      this.preloadRejecters.push(reject);
      this.send({ kind: "preload", id: "preload" });
    });
  }

  /** The capabilities learned from the last preload/ready, or null if unknown. */
  getCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }

  /**
   * Run a simulation. Returns an async iterable of events for THIS run only
   * (correlated by `req.id`). Consume with `for await`. The stream ends after a
   * terminal `result` or `error` event, or after `cancel(req.id)`.
   */
  run(req: SimRequest): AsyncIterable<SimEvent> {
    const queue: SimEvent[] = [];
    let notify: (() => void) | null = null;
    let ended = false;

    const channel: RunChannel = {
      id: req.id,
      push: (ev) => {
        queue.push(ev);
        notify?.();
      },
      end: () => {
        ended = true;
        notify?.();
      },
      ended: false,
    };
    this.channels.set(req.id, channel);
    this.send({ kind: "run", request: req });

    const iterator: AsyncIterator<SimEvent> = {
      next: () =>
        new Promise<IteratorResult<SimEvent>>((resolve) => {
          let settled = false;
          const pump = () => {
            if (settled) return;
            if (queue.length > 0) {
              settled = true;
              notify = null;
              resolve({ value: queue.shift() as SimEvent, done: false });
              return;
            }
            if (ended) {
              settled = true;
              notify = null;
              resolve({ value: undefined as unknown as SimEvent, done: true });
              return;
            }
            notify = pump;
          };
          pump();
        }),
      return: () => {
        this.closeChannel(req.id);
        return Promise.resolve({ value: undefined as unknown as SimEvent, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /**
   * Cancel a run. Because eecircuit cannot interrupt an in-flight transient
   * (ADR 0011), cancellation TERMINATES the worker and spawns a fresh one. Every
   * open run is settled with a synthetic SIM-CANCELED error so awaiting
   * consumers unwind. The new worker's engine is pristine and immediately usable.
   */
  cancel(id: string): void {
    if (!this.channels.has(id)) return;
    // Hard-kill the worker: the only reliable interrupt for a fire-and-forget run.
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    // Settle the canceled run and any other in-flight runs on the dead worker.
    for (const openId of [...this.channels.keys()]) {
      this.pushError(openId, "SIM-CANCELED", `run ${id} canceled by client`);
      this.closeChannel(openId);
    }
    // Preload state is stale now; a fresh worker re-learns capabilities.
    this.capabilities = null;
    // Respawn eagerly so the next run() starts against a live worker.
    this.ensureWorker();
  }

  /** Terminate the worker and release resources. The client is unusable after. */
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.channels.keys()]) this.closeChannel(id);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}
