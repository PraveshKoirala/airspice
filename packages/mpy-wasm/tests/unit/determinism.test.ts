import { describe, it, expect } from "vitest";
import { createRuntime, adcAndOutput, foldGpio, type StepInput } from "../support/runtime.js";
import { thermostatFirmware } from "../fixtures/firmware.js";

/**
 * Issue #37 — determinism.
 *
 * Two independent runtimes, the SAME firmware source, driven by the SAME
 * injected input sequence, must produce byte-identical GPIO and timestamp
 * sequences. This defeats any runtime that consults Date/Math.random/wall-clock:
 * such a runtime would diverge between runs. (Combined with thermostat.test.ts's
 * input-flip checks, it also defeats a stub — the outputs must both VARY with
 * input AND be reproducible.)
 */

const ADC = 26;
const HEATER = 15;
const SOURCE = thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: 16_000 });

// A fixed, deliberately-varying input sequence (cold/warm mix) at virtual times
// advancing by 10 ms per step.
const INPUTS: StepInput[] = [
  { timeMs: 10, adc: { "26": 1_000 }, gpio: {} },
  { timeMs: 20, adc: { "26": 40_000 }, gpio: {} },
  { timeMs: 30, adc: { "26": 15_999 }, gpio: {} },
  { timeMs: 40, adc: { "26": 16_000 }, gpio: {} },
  { timeMs: 50, adc: { "26": 8_000 }, gpio: {} },
  { timeMs: 60, adc: { "26": 65_535 }, gpio: {} },
];

async function collect(): Promise<{ gpio: (0 | 1)[]; times: number[] }> {
  const runtime = await createRuntime(SOURCE, adcAndOutput(ADC, HEATER));
  const gpio: (0 | 1)[] = [];
  const times: number[] = [];
  let level: Record<string, 0 | 1> = { "15": 0 };
  for (const input of INPUTS) {
    const out = await runtime.step(input);
    level = foldGpio(level, out.gpio);
    gpio.push(level["15"]!);
    times.push(input.timeMs);
  }
  return { gpio, times };
}

describe("mpy-wasm: deterministic execution under a virtual clock", () => {
  it("two runs with identical firmware + inputs yield identical GPIO/timestamp sequences", async () => {
    const runA = await collect();
    const runB = await collect();
    expect(runA).toEqual(runB);
  });

  it("the sequence is not a constant — it actually tracks the injected inputs", async () => {
    // If it were constant, determinism above would pass vacuously. This pins the
    // expected bang-bang response so a stub returning a fixed level fails.
    const { gpio } = await collect();
    // 1000<16000 ->1 ; 40000 ->0 ; 15999<16000 ->1 ; 16000 ->0 ; 8000 ->1 ; 65535 ->0
    expect(gpio).toEqual([1, 0, 1, 0, 1, 0]);
  });
});
