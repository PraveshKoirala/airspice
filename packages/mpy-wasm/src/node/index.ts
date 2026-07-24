/**
 * mpy-wasm Node adapter (issue #37): a {@link MicroPythonLoader} that loads the
 * real MicroPython WASM under Node, plus a convenience factory.
 *
 * This subpath (`mpy-wasm/node`) is kept separate from the package root so
 * `node:module` never enters a browser bundle — exactly as sim-wasm isolates
 * `node:worker_threads` in its own `./node` subpath. The MicroPython `.mjs`
 * auto-detects Node and instantiates the WASM synchronously off `fs`; we resolve
 * the `.wasm` path via `createRequire` and hand it in as `url` so `locateFile`
 * finds it regardless of cwd.
 *
 * Verified: this path loads the real WASM in Node and executes firmware Python
 * (see the package README + tests). It is the environment the co-sim tests run
 * against.
 */

import { createRequire } from "node:module";
import { MpyFirmwareRuntime } from "../runtime.js";
import type {
  MicroPythonInstance,
  MicroPythonLoader,
  MpyRuntimeOptions,
} from "../types.js";

const require = createRequire(import.meta.url);

/**
 * A {@link MicroPythonLoader} backed by the real MicroPython WASM in Node.
 * Resolves the packaged `micropython.wasm` and loads it with line-buffering off
 * (no stdout noise, deterministic).
 */
export const nodeMicroPythonLoader: MicroPythonLoader =
  async (): Promise<MicroPythonInstance> => {
    const { loadMicroPython } = await import(
      "@micropython/micropython-webassembly-pyscript"
    );
    const wasmPath = require.resolve(
      "@micropython/micropython-webassembly-pyscript/micropython.wasm",
    );
    const mp = await loadMicroPython({ url: wasmPath, linebuffer: false });
    return mp as unknown as MicroPythonInstance;
  };

/**
 * Convenience: a {@link MpyFirmwareRuntime} wired to the Node loader. Call
 * `await runtime.init(firmwareSource, bindings)` then `runtime.step(...)`.
 */
export function createNodeRuntime(
  options?: MpyRuntimeOptions,
): MpyFirmwareRuntime {
  return new MpyFirmwareRuntime(nodeMicroPythonLoader, options);
}

export { MpyFirmwareRuntime };
