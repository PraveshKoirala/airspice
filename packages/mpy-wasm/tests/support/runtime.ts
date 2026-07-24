/**
 * Shared test support for the mpy-wasm runtime (issue #37) — hermetic tests.
 *
 * These tests are authored TEST-FIRST, against the PRD contract, WITHOUT the
 * implementation present. They come to life once `hermetic/37-build` lands the
 * `packages/mpy-wasm/src` package (real MicroPython WASM runtime) alongside
 * `packages/sim-wasm/src/cosim.ts` (the FirmwareModel + CoSimOrchestrator from
 * issue #38). Run with:  `npm --workspace mpy-wasm test`.
 *
 * ── RUNTIME API (confirmed against packages/mpy-wasm/src on hermetic/37-build) ─
 * The MicroPython instance is INJECTED via a loader, so the runtime constructor
 * REQUIRES one: `new MpyFirmwareRuntime(loader, options?)`. For Node there is a
 * convenience factory `createNodeRuntime(options?)` (exported from
 * `packages/mpy-wasm/src/node/index.ts`) that wires the real Node WASM loader —
 * that is the environment the WASM runs in, so the suite builds runtimes through
 * it. Construction is CENTRALISED here so a single edit adapts every test:
 *
 *   import { createNodeRuntime } from "../../src/node/index.js";
 *   const rt = createNodeRuntime();                      // node WASM loader wired
 *   await rt.init(firmwareSource, bindings);             // loads WASM + setup()
 *   const { gpio } = rt.step({ timeMs, adc, gpio });     // one virtual tick (sync)
 *
 * `step` is byte-compatible with sim-wasm's `FirmwareModel` (issue #38):
 *   step(input: { timeMs; adc: Record<string,number>; gpio: Record<string,0|1> })
 *     => { gpio?: Record<string,0|1> }   (this build returns the full GPIO snapshot;
 *                                          the tests `await` it, tolerating async too)
 *
 * ── PIN-KEY CONVENTION (confirmed: MachineBridge keys by String(id)) ─────────
 * The firmware refers to pins by id in `machine.ADC(id)` / `machine.Pin(id,…)`.
 * The runtime keys the `adc` input map and the `gpio` output map by `String(id)`.
 * So `machine.ADC(26).read_u16()` reads `input.adc["26"]`, and
 * `machine.Pin(15, machine.Pin.OUT).value(1)` surfaces as `output.gpio["15"] = 1`.
 *
 * ── VIRTUAL CLOCK (confirmed) ────────────────────────────────────────────────
 * `machine.ticks_ms()` (and `time`/`utime` `ticks_ms`) return the integer virtual
 * time supplied as `input.timeMs` — never wall-clock. `sleep`/`sleep_ms`/`sleep_us`
 * are no-ops and live on the `time`/`utime` module (NOT on `machine`).
 */

// The runtime under test, built through the Node loader factory (imported from
// the `mpy-wasm/node` SOURCE subpath). Relative-source import mirrors sim-wasm's
// own unit tests (`../../src/cosim.js`) so the suite needs no prior build and no
// vitest alias — it exercises exactly the source the builder ships.
import { createNodeRuntime } from "../../src/node/index.js";
import type { MpyFirmwareRuntime } from "../../src/runtime.js";

/**
 * MCU pin declaration handed to `init` (structural subset of cosim.ts's
 * PinBinding). Bindings are optional to the runtime — they pre-seed output pins
 * to 0 / record inputs — but we pass accurate ones to exercise that path.
 */
export interface MpyPinBinding {
  /** Pin id as used in `machine.Pin(id, …)` / `machine.ADC(id)`, stringified. */
  mcuPin: string;
  direction: "input" | "output";
}

/** One firmware step's input, structurally identical to FirmwareStepInput. */
export interface StepInput {
  timeMs: number;
  adc: Record<string, number>;
  gpio: Record<string, 0 | 1>;
}

/** One firmware step's output, structurally identical to FirmwareStepOutput. */
export interface StepOutput {
  gpio?: Record<string, 0 | 1>;
}

/**
 * Construct + initialise a runtime. Awaits the (async) WASM load + `setup()`.
 * The SINGLE place that encodes the construction API.
 */
export async function createRuntime(
  firmwareSource: string,
  bindings: MpyPinBinding[],
): Promise<MpyFirmwareRuntime> {
  const runtime = createNodeRuntime();
  await runtime.init(firmwareSource, bindings);
  return runtime;
}

/** Bindings for a single ADC input + a single GPIO output. */
export function adcAndOutput(adcPin: number, outPin: number): MpyPinBinding[] {
  return [
    { mcuPin: String(adcPin), direction: "input" },
    { mcuPin: String(outPin), direction: "output" },
  ];
}

/** Bindings for `count` consecutive output pins starting at `basePin`. */
export function outputBits(basePin: number, count: number): MpyPinBinding[] {
  return Array.from({ length: count }, (_, i) => ({
    mcuPin: String(basePin + i),
    direction: "output" as const,
  }));
}

/**
 * Fold a step's GPIO output onto the prior effective levels. Per the #38
 * `FirmwareStepOutput` contract ("Omitted pins keep their prior level"), a
 * runtime may return the full output map OR only the pins that changed. Folding
 * makes the direct-runtime assertions correct under BOTH conventions (and
 * mirrors how CoSimOrchestrator itself applies firmware output).
 */
export function foldGpio(
  prev: Record<string, 0 | 1>,
  delta: Record<string, 0 | 1> | undefined,
): Record<string, 0 | 1> {
  return { ...prev, ...(delta ?? {}) };
}

/** Reconstruct an unsigned integer from little-endian GPIO bit pins. */
export function decodeBits(
  gpio: Record<string, 0 | 1>,
  basePin: number,
  count: number,
): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const bit = gpio[String(basePin + i)] ?? 0;
    value |= bit << i;
  }
  return value >>> 0;
}
