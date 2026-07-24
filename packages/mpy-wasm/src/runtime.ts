/**
 * MpyFirmwareRuntime — runs a design's firmware Python (setup()/loop()) on the
 * REAL MicroPython WASM under a deterministic virtual clock, exposing a
 * FirmwareModel-compatible step() so #38's CoSimOrchestrator can drive
 * firmware ⇄ analog lockstep (see packages/sim-wasm/src/cosim.ts).
 *
 * The MicroPython instance is INJECTED via a {@link MicroPythonLoader}, so the
 * same runtime core runs in Node (node loader) and the browser worker (browser
 * loader) without env branches. init() loads MicroPython, installs the
 * machine/time bridges, runs the firmware source and its setup(); each step()
 * injects ADC/GPIO inputs, sets the virtual clock, calls loop(), and reads back
 * the GPIO levels the firmware's own Python logic decided.
 */

import { MachineBridge } from "./machine.js";
import type {
  FirmwareModel,
  FirmwareStepInput,
  FirmwareStepOutput,
  MicroPythonLoader,
  MpyPinBinding,
  MpyRuntimeOptions,
} from "./types.js";

type PyCallable = (...args: unknown[]) => unknown;

export class MpyFirmwareRuntime implements FirmwareModel {
  private readonly loader: MicroPythonLoader;
  private readonly bridge = new MachineBridge();
  private readonly stepMs: number;
  private setupFn: PyCallable | undefined;
  private loopFn: PyCallable | undefined;
  private inited = false;

  constructor(loader: MicroPythonLoader, options?: MpyRuntimeOptions) {
    this.loader = loader;
    this.stepMs = options?.stepMs ?? 1;
  }

  /** Virtual ms per tick this runtime was configured with (informational). */
  getStepMs(): number {
    return this.stepMs;
  }

  /** Current virtual clock in ms (integer). */
  getClockMs(): number {
    return this.bridge.getClockMs();
  }

  /**
   * Load MicroPython, install the `machine`/`time`/`utime` bridges, run the
   * firmware source, and call its setup() once at virtual t=0.
   *
   * @param firmwareSource MicroPython source defining `setup()` and `loop()`.
   * @param bindings Optional pin declarations; pre-seed outputs to 0 / inputs.
   */
  async init(
    firmwareSource: string,
    bindings?: readonly MpyPinBinding[],
  ): Promise<void> {
    const mp = await this.loader();

    if (bindings) {
      for (const b of bindings) {
        if (b.direction === "output") this.bridge.setGpio(b.mcuPin, 0);
        else this.bridge.setAdc(b.mcuPin, 0);
      }
    }

    // Install bridges BEFORE running firmware so `import machine` resolves.
    mp.registerJsModule("machine", this.bridge.machineModule());
    const timeMod = this.bridge.timeModule();
    mp.registerJsModule("time", timeMod);
    mp.registerJsModule("utime", timeMod);

    this.bridge.setClockMs(0);
    mp.runPython(firmwareSource);

    const loopFn = mp.globals.get("loop");
    if (typeof loopFn !== "function") {
      throw new Error("firmware must define a loop() function");
    }
    this.loopFn = loopFn as PyCallable;

    const setupFn = mp.globals.get("setup");
    if (typeof setupFn === "function") {
      this.setupFn = setupFn as PyCallable;
      this.setupFn();
    }

    this.inited = true;
  }

  /**
   * One firmware behavioral step. Injects the ADC/GPIO inputs, advances the
   * virtual clock to `input.timeMs`, runs the firmware's loop() (REAL Python),
   * and returns the GPIO levels the firmware set. Synchronous and deterministic:
   * identical inputs → identical outputs, no wall-clock consulted.
   */
  step(input: FirmwareStepInput): FirmwareStepOutput {
    if (!this.inited || !this.loopFn) {
      throw new Error("MpyFirmwareRuntime.init() must be awaited before step()");
    }

    for (const [pin, value] of Object.entries(input.adc)) {
      this.bridge.setAdc(pin, value);
    }
    for (const [pin, level] of Object.entries(input.gpio)) {
      this.bridge.setGpio(pin, level);
    }
    this.bridge.setClockMs(input.timeMs);

    this.loopFn();

    return { gpio: this.bridge.snapshotGpio() };
  }
}
