/**
 * Public types for the MicroPython firmware runtime (issue #37).
 *
 * The FirmwareModel / FirmwareStepInput / FirmwareStepOutput interfaces below
 * are a byte-for-byte mirror of the contract in
 * `packages/sim-wasm/src/cosim.ts` (issue #38's CoSimOrchestrator). They are
 * copied — not imported — so this package has no build-order coupling to
 * sim-wasm, while remaining structurally drop-in: a `MpyFirmwareRuntime`
 * satisfies sim-wasm's `FirmwareModel` by TypeScript's structural typing, and
 * an instance can be handed straight to `new CoSimOrchestrator(analog, runtime,
 * opts)`. If cosim.ts's contract ever changes, this must change with it.
 */

/** Inputs to one firmware behavioral step (mirror of cosim.ts). */
export interface FirmwareStepInput {
  timeMs: number;
  /** MCU input pin → ADC value (uint16). */
  adc: Record<string, number>;
  /** MCU output pin → current level. */
  gpio: Record<string, 0 | 1>;
}

/** Outputs of one firmware behavioral step (mirror of cosim.ts). */
export interface FirmwareStepOutput {
  /** MCU output pin → new level. Omitted pins keep their prior level. */
  gpio?: Record<string, 0 | 1>;
}

/** The firmware domain: one behavioral step (mirror of cosim.ts). */
export interface FirmwareModel {
  step(input: FirmwareStepInput): FirmwareStepOutput | Promise<FirmwareStepOutput>;
}

/**
 * Minimal pin declaration accepted by {@link MpyFirmwareRuntime.init}. This is a
 * structural subset of cosim.ts's `PinBinding` (which additionally carries
 * analog-side `net`/`deviceId`/`vHigh`/`vref`), so a full `PinBinding[]` is
 * assignable here — only `mcuPin` and `direction` matter to the firmware side.
 * Bindings are optional: they pre-seed output pins to 0 and record which pins
 * are inputs, but the firmware itself declares its pins via `machine.Pin`/`ADC`
 * and step() drives everything from the injected `adc`/`gpio` records.
 */
export interface MpyPinBinding {
  mcuPin: string;
  direction: "input" | "output";
}

/**
 * The subset of the MicroPython WASM instance (returned by `loadMicroPython()`)
 * that this runtime depends on. See the package README for the discovered API.
 */
export interface MicroPythonInstance {
  /** Register a JS object as a Python-importable module (`import <name>`). */
  registerJsModule(name: string, module: unknown): void;
  /** Execute Python source synchronously. */
  runPython(code: string): unknown;
  /** Execute Python source with asyncify support. */
  runPythonAsync(code: string): Promise<unknown>;
  /** Import a Python module, returning a JS proxy. */
  pyimport(name: string): unknown;
  /** Access to the `__main__` global namespace. */
  globals: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
}

/** Loads and returns a ready MicroPython instance (env-specific). */
export type MicroPythonLoader = () => Promise<MicroPythonInstance>;

export interface MpyRuntimeOptions {
  /**
   * Virtual milliseconds per tick. Informational only for the runtime — the
   * authoritative virtual time comes from each step's `timeMs` (which the
   * CoSimOrchestrator advances by its own stepMs). Default 1.
   */
  stepMs?: number;
}
