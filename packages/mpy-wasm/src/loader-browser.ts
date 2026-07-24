/**
 * Browser-side MicroPython loader factory.
 *
 * In the browser the `.wasm` asset URL is bundler-owned (Vite resolves it via a
 * `?url` import, Webpack via `new URL(..., import.meta.url)`), so the caller
 * passes the resolved URL rather than this package guessing it. The dynamic
 * `import()` keeps the ~450KB WASM off the initial page bundle (it loads only
 * when the runtime is first constructed) and, in a Web Worker, off the main
 * thread — mirroring sim-wasm's lazy-chunk strategy.
 *
 * Example (Vite, inside the worker):
 *   import wasmUrl from
 *     "@micropython/micropython-webassembly-pyscript/micropython.wasm?url";
 *   const runtime = new MpyFirmwareRuntime(browserMicroPythonLoader(wasmUrl));
 */

import type { MicroPythonInstance, MicroPythonLoader } from "./types.js";

/**
 * Build a {@link MicroPythonLoader} that loads the real MicroPython WASM in the
 * browser from a bundler-resolved `wasmUrl`.
 */
export function browserMicroPythonLoader(wasmUrl: string): MicroPythonLoader {
  return async (): Promise<MicroPythonInstance> => {
    const { loadMicroPython } = await import(
      "@micropython/micropython-webassembly-pyscript"
    );
    const mp = await loadMicroPython({ url: wasmUrl, linebuffer: false });
    return mp as unknown as MicroPythonInstance;
  };
}
