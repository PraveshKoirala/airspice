/**
 * sim-wasm Node adapter (issue #40): a `WorkerFactory` that runs the engine
 * worker on a Node `worker_threads` thread instead of a browser `Worker`.
 *
 * `SimClient` is transport-agnostic by design — it takes an injectable
 * `WorkerFactory` and talks to whatever it returns through the Web Worker
 * surface (`addEventListener` / `postMessage` / `terminate`). The browser
 * supplies `defaultWorkerFactory` (a real `Worker`); here we supply
 * `nodeWorkerFactory`, which spawns the worker_threads entry and wraps its
 * EventEmitter API in that same Web Worker surface. Nothing about `SimClient`
 * or the engine worker changes — this is the one place the two worlds meet.
 *
 * This subpath (`sim-wasm/node`) is intentionally separate from the package
 * root so `node:worker_threads` never enters the browser bundle.
 */

import { Worker as NodeWorker } from "node:worker_threads";

/** Adapts a worker_threads Worker to the Web Worker surface SimClient uses. */
class NodeWorkerAdapter {
  private readonly worker: NodeWorker;

  constructor() {
    // dist/node/index.js → dist/node/worker-entry.js (sibling, compiled ESM).
    this.worker = new NodeWorker(new URL("./worker-entry.js", import.meta.url));
  }

  addEventListener(type: "message" | "error", listener: (ev: unknown) => void): void {
    if (type === "message") {
      this.worker.on("message", (data: unknown) => listener({ data }));
    } else {
      this.worker.on("error", (err: unknown) =>
        listener({ message: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  postMessage(message: unknown, transfer?: unknown[]): void {
    if (transfer && transfer.length) {
      (this.worker.postMessage as (v: unknown, t?: unknown[]) => void)(message, transfer);
    } else {
      this.worker.postMessage(message);
    }
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

/**
 * A `WorkerFactory` (see `SimClient`) that backs the engine with a Node
 * worker_threads thread. Pass it to `new SimClient(nodeWorkerFactory)` to run
 * real ngspice off the main thread in Node.
 */
export function nodeWorkerFactory(): Worker {
  return new NodeWorkerAdapter() as unknown as Worker;
}
