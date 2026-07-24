/**
 * Ambient types for `@micropython/micropython-webassembly-pyscript` (1.28.0-6),
 * which ships no `.d.ts`. Shapes were reverse-engineered from its `micropython.mjs`
 * (see README "Real package API"): `loadMicroPython(options)` resolves to an
 * instance exposing `registerJsModule`, `runPython`, `runPythonAsync`, `pyimport`,
 * `globals`, and `FS`.
 */
declare module "@micropython/micropython-webassembly-pyscript" {
  export interface LoadMicroPythonOptions {
    /** Explicit URL/path to the .wasm (else derived from the .mjs location). */
    url?: string;
    stdin?: () => string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
    /** Line-buffer stdout/stderr (default true). */
    linebuffer?: boolean;
    heapsize?: number;
    pystack?: number;
  }

  export interface MicroPythonApi {
    registerJsModule(name: string, module: unknown): void;
    runPython(code: string): unknown;
    runPythonAsync(code: string): Promise<unknown>;
    pyimport(name: string): unknown;
    globals: {
      get(key: string): unknown;
      set(key: string, value: unknown): void;
      delete(key: string): void;
    };
    FS: unknown;
    _module: unknown;
  }

  export function loadMicroPython(
    options?: LoadMicroPythonOptions,
  ): Promise<MicroPythonApi>;
}
