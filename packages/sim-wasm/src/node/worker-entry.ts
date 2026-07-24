/**
 * Node worker_threads entry for the sim-wasm engine (issue #40).
 *
 * WHY THIS EXISTS: `engine.worker.ts` is written against the Web Worker contract
 * (`self.addEventListener("message")` / `self.postMessage`), because in the
 * browser it is loaded as a real `Worker`. Running the SAME engine worker in
 * Node (so an MCP server can drive real ngspice off the main thread, exactly as
 * the browser does) means bridging worker_threads' `parentPort` EventEmitter API
 * to that Web Worker surface. That bridge is a sim-wasm concern — the engine
 * worker's browser-shaped I/O is the contract detail — so the fix lives HERE, at
 * the source, not shimmed into a downstream consumer.
 *
 * This module installs a minimal `self` on `globalThis` that forwards to
 * `parentPort`, THEN dynamically imports the unmodified compiled engine worker.
 * The dynamic import (not a static one) is load-bearing: a static import is
 * hoisted and evaluated before the `self` assignment runs, so the engine
 * worker's top-level `const ctx = self` would see `undefined`. Awaiting the
 * import here also guarantees the engine's `message` listener is registered
 * before we start forwarding inbound messages.
 */

import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error(
    "sim-wasm/node/worker-entry must be run as a worker_threads Worker (no parentPort).",
  );
}
const port = parentPort;

type MessageListener = (ev: { data: unknown }) => void;
const messageListeners = new Set<MessageListener>();

/** The subset of the Web Worker global surface `engine.worker.ts` touches. */
const selfShim = {
  postMessage(message: unknown, transfer?: unknown[]): void {
    if (transfer && transfer.length) {
      (port.postMessage as (v: unknown, t?: unknown[]) => void)(message, transfer);
    } else {
      port.postMessage(message);
    }
  },
  addEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
    if (type === "message") messageListeners.add(listener);
  },
  removeEventListener(type: string, listener: (ev: { data: unknown }) => void): void {
    if (type === "message") messageListeners.delete(listener);
  },
};

(globalThis as unknown as Record<string, unknown>)["self"] = selfShim;

// Import the engine worker AFTER `self` is installed; its top-level code reads
// `self` and registers the `message` listener synchronously during eval.
await import("../engine.worker.js");

// Forward inbound worker_threads messages as Web-Worker-style `{ data }` events.
// Registered after the import so the engine's listener already exists.
port.on("message", (value: unknown) => {
  for (const listener of messageListeners) listener({ data: value });
});
