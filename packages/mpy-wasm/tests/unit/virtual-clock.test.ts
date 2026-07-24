import { describe, it, expect } from "vitest";
import {
  createRuntime,
  adcAndOutput,
  outputBits,
  decodeBits,
  foldGpio,
} from "../support/runtime.js";
import { clockProbeFirmware, sleepingThermostatFirmware } from "../fixtures/firmware.js";

/**
 * Issue #37 — virtual clock (never wall-clock).
 *
 * Two independent guarantees:
 *  (1) VALUE: the time the firmware observes via `machine.ticks_ms()` equals the
 *      VIRTUAL `timeMs` injected for that step (tick*stepMs) — proven by having
 *      the firmware bit-encode ticks_ms onto GPIO and reconstructing it. A
 *      wall-clock source (epoch ms) would not equal the small injected values;
 *      a stub would not count at all.
 *  (2) COST: `time.sleep_ms(big)` must NOT block on the wall clock. Many steps
 *      that each "sleep" a large virtual interval must still return fast. A
 *      runtime honouring the sleep against real time would blow the bound.
 */

const BASE = 100; // bit pins 100..107
const BITS = 8; // encodes values 0..255

describe("mpy-wasm: firmware observes the VIRTUAL clock, not the wall clock", () => {
  it("machine.ticks_ms() returns exactly the injected virtual timeMs each step", async () => {
    const runtime = await createRuntime(
      clockProbeFirmware({ basePin: BASE, bits: BITS }),
      outputBits(BASE, BITS),
    );

    // Non-monotonic, arbitrary virtual times (all <= 255 to fit BITS). A monotone
    // "counter" stub cannot reproduce the jumps; a wall clock cannot hit them.
    const injected = [0, 1, 10, 42, 100, 55, 200, 255];
    let level: Record<string, 0 | 1> = {};
    for (const timeMs of injected) {
      const out = await runtime.step({ timeMs, adc: {}, gpio: {} });
      level = foldGpio(level, out.gpio);
      const observed = decodeBits(level, BASE, BITS);
      expect(observed).toBe(timeMs);
    }
  });

  it("advances by stepMs per tick: reconstructed time == tick*stepMs", async () => {
    const runtime = await createRuntime(
      clockProbeFirmware({ basePin: BASE, bits: BITS }),
      outputBits(BASE, BITS),
    );
    const stepMs = 10;
    let level: Record<string, 0 | 1> = {};
    for (let tick = 1; tick <= 12; tick++) {
      const timeMs = tick * stepMs; // the orchestrator's virtual clock convention
      const out = await runtime.step({ timeMs, adc: {}, gpio: {} });
      level = foldGpio(level, out.gpio);
      expect(decodeBits(level, BASE, BITS)).toBe(timeMs);
    }
  });

  it("time.sleep_ms does not spend wall-clock time — many big sleeps still return fast", async () => {
    const ADC = 26;
    const HEATER = 15;
    const STEPS = 15;
    const SLEEP_MS = 1_000; // 15 steps => 15 s of *virtual* sleep

    const runtime = await createRuntime(
      sleepingThermostatFirmware({
        adcPin: ADC,
        heaterPin: HEATER,
        threshold: 16_000,
        sleepMs: SLEEP_MS,
      }),
      adcAndOutput(ADC, HEATER),
    );

    // Measure ONLY the step loop (init/WASM load is excluded).
    const start = Date.now();
    const outputs: (0 | 1)[] = [];
    let level: Record<string, 0 | 1> = { "15": 0 };
    for (let i = 0; i < STEPS; i++) {
      // alternate cold/warm so we also confirm the step really executed
      const reading = i % 2 === 0 ? 1_000 : 60_000;
      const out = await runtime.step({ timeMs: (i + 1) * SLEEP_MS, adc: { "26": reading }, gpio: {} });
      level = foldGpio(level, out.gpio);
      outputs.push(level["15"]!);
    }
    const wallMs = Date.now() - start;

    // A real 15 x 1000 ms wall-clock sleep would take ~15 s. Virtual clock: ~ms.
    // Generous bound tolerates slow CI + MicroPython exec while still catching a
    // wall-clock sleep by an order of magnitude.
    expect(wallMs).toBeLessThan(5_000);

    // ...and the firmware genuinely ran its branch each step (not skipped).
    expect(outputs).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });
});
