/**
 * Local engine (issue #10): air-ts running in a Web Worker, driven by the
 * hand-rolled typed RPC in ./protocol. This is the zero-backend path -- with
 * `VITE_ENGINE=local` and NO FastAPI server running, the Schematic and
 * Validation tabs are computed entirely in-browser.
 *
 * A single long-lived worker handles every request; each request gets a
 * monotonic id and a pending promise that the worker's echoed id settles. The
 * worker is created lazily on first use so the app start cost isn't paid by
 * users who never touch it.
 */

import type {
  AirEngine,
  GraphData,
  DiagnosticsPayload,
  EngineMode,
} from './types';
import { NotImplementedError } from './types';
import type { EngineMethod, EngineRequest, EngineResponse } from './protocol';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

class LocalEngine implements AirEngine {
  readonly mode: EngineMode = 'local';
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    // Vite resolves this URL form at build time and bundles the worker as a
    // separate chunk (module worker). air-ts is imported inside the worker.
    const worker = new Worker(new URL('./graph.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', (event: MessageEvent<EngineResponse>) => {
      const { id } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (event.data.ok) entry.resolve(event.data.result);
      else entry.reject(new Error(event.data.error));
    });
    worker.addEventListener('error', (event) => {
      // A hard worker error rejects everything in flight so callers don't hang.
      const err = new Error(`engine worker error: ${event.message}`);
      for (const [, entry] of this.pending) entry.reject(err);
      this.pending.clear();
    });
    this.worker = worker;
    return worker;
  }

  private call<M extends EngineMethod>(method: M, xml: string): Promise<unknown> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: EngineRequest = { id, method, xml };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  toGraph(xml: string): Promise<GraphData> {
    return this.call('toGraph', xml) as Promise<GraphData>;
  }

  validate(xml: string): Promise<DiagnosticsPayload> {
    return this.call('validate', xml) as Promise<DiagnosticsPayload>;
  }

  simulate(): Promise<never> {
    // #14 fills this in (simulation in a WASM worker). Until then, loud failure.
    return Promise.reject(new NotImplementedError('simulate', 'issue #14'));
  }

  applyPatch(): Promise<never> {
    // #11 fills this in (patch apply/normalize in air-ts). Until then, loud.
    return Promise.reject(new NotImplementedError('applyPatch', 'issue #11'));
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [, entry] of this.pending) {
      entry.reject(new Error('engine disposed'));
    }
    this.pending.clear();
  }
}

export function createLocalEngine(): AirEngine {
  return new LocalEngine();
}
