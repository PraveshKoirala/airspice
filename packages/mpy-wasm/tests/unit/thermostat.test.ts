import { describe, it, expect } from "vitest";
import { createRuntime, adcAndOutput, foldGpio } from "../support/runtime.js";
import { thermostatFirmware } from "../fixtures/firmware.js";

/**
 * Issue #37 — init + step against REAL MicroPython.
 *
 * A real thermostat firmware's Python threshold branch must decide the heater
 * GPIO. These tests FLIP the injected ADC value and VARY the Python-level
 * threshold constant, so a stub runtime that returns canned GPIO cannot pass:
 * its output would not track the input, nor move when the firmware's own
 * constant moves.
 */

const ADC = 26; // MicroPython ADC pin id -> adc key "26"
const HEATER = 15; // GPIO output pin id -> gpio key "15"
const COLD = 2_000; // read_u16() well below threshold
const WARM = 60_000; // read_u16() well above threshold
const THRESHOLD = 16_000;

describe("mpy-wasm: real MicroPython thermostat (init + step)", () => {
  it("drives the heater HIGH when the sensor reads cold, LOW when warm", async () => {
    const runtime = await createRuntime(
      thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: THRESHOLD }),
      adcAndOutput(ADC, HEATER),
    );

    const cold = await runtime.step({ timeMs: 1, adc: { "26": COLD }, gpio: {} });
    expect(cold.gpio?.["15"]).toBe(1);

    const warm = await runtime.step({ timeMs: 2, adc: { "26": WARM }, gpio: {} });
    expect(warm.gpio?.["15"]).toBe(0);
  });

  it("FLIPS the output when the injected ADC value flips — the branch, not a canned stub", async () => {
    const runtime = await createRuntime(
      thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: THRESHOLD }),
      adcAndOutput(ADC, HEATER),
    );

    // Same runtime, alternating input. A stub returning a fixed GPIO fails here:
    // the sequence must track the input flips exactly.
    const seq = [COLD, WARM, COLD, COLD, WARM];
    const expected = [1, 0, 1, 1, 0];
    let level: Record<string, 0 | 1> = { "15": 0 }; // post-setup() state
    const got: (0 | 1)[] = [];
    for (let i = 0; i < seq.length; i++) {
      const out = await runtime.step({ timeMs: i + 1, adc: { "26": seq[i]! }, gpio: {} });
      level = foldGpio(level, out.gpio);
      got.push(level["15"]!);
    }
    expect(got).toEqual(expected);
  });

  it("moves the decision boundary when the firmware's OWN threshold constant changes", async () => {
    // A single ADC value that is BELOW the low threshold but ABOVE the high one.
    // Only the firmware's Python constant can flip the result for a fixed input,
    // so a stub (which cannot see the constant) cannot reproduce both outcomes.
    const midReading = 30_000;

    const lowThresh = await createRuntime(
      thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: 16_000 }),
      adcAndOutput(ADC, HEATER),
    );
    const highThresh = await createRuntime(
      thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: 50_000 }),
      adcAndOutput(ADC, HEATER),
    );

    const outLow = await lowThresh.step({ timeMs: 1, adc: { "26": midReading }, gpio: {} });
    const outHigh = await highThresh.step({ timeMs: 1, adc: { "26": midReading }, gpio: {} });
    const levelLow = foldGpio({ "15": 0 }, outLow.gpio)["15"];
    const levelHigh = foldGpio({ "15": 0 }, outHigh.gpio)["15"];

    // 30000 >= 16000 -> heater OFF ; 30000 < 50000 -> heater ON.
    expect(levelLow).toBe(0);
    expect(levelHigh).toBe(1);
    // Same input, opposite output — decided purely by the Python threshold.
    expect(levelLow).not.toBe(levelHigh);
  });
});
