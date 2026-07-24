/// <reference lib="webworker" />
/**
 * mpy-wasm Web Worker entry (issue #37) — loads the real MicroPython WASM OFF
 * the main thread and drives an {@link MpyFirmwareRuntime} behind the
 * {@link WorkerInbound}/{@link WorkerOutbound} message protocol.
 *
 * The WASM is loaded lazily on the `init` message via the browser loader (a
 * dynamic import of the MicroPython package), so the ~450KB binary is a separate
 * bundler chunk and never touches the main thread — the same worker-only rule
 * sim-wasm's engine.worker follows. The heavy runtime lives entirely here; the
 * main thread talks to it through {@link MpyWorkerFirmware} (worker-client.ts),
 * which is itself a FirmwareModel and thus drop-in for CoSimOrchestrator.
 *
 * NOTE: verified end-to-end in Node (see README); the browser path is wired by
 * construction (same runtime core, same real WASM) and depends on the host app
 * supplying the bundler-resolved `wasmUrl` in the init message.
 */

import { MpyFirmwareRuntime } from "./runtime.js";
import { browserMicroPythonLoader } from "./loader-browser.js";
import type { WorkerInbound, WorkerOutbound } from "./protocol.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let runtime: MpyFirmwareRuntime | undefined;

function post(msg: WorkerOutbound): void {
  ctx.postMessage(msg);
}

ctx.addEventListener("message", (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  void handle(msg);
});

async function handle(msg: WorkerInbound): Promise<void> {
  try {
    if (msg.type === "init") {
      runtime = new MpyFirmwareRuntime(browserMicroPythonLoader(msg.wasmUrl), {
        stepMs: msg.stepMs ?? 1,
      });
      await runtime.init(msg.firmwareSource, msg.bindings);
      post({ type: "init:ok", id: msg.id });
      return;
    }
    if (msg.type === "step") {
      if (!runtime) throw new Error("worker received step before init");
      const output = runtime.step(msg.input);
      post({ type: "step:ok", id: msg.id, output });
      return;
    }
  } catch (err) {
    post({
      type: "error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
