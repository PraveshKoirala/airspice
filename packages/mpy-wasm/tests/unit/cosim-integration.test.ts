import { describe, it, expect } from "vitest";
// Imported from sim-wasm's SOURCE (relative), mirroring sim-wasm's own
// cosim.test.ts (`../../src/cosim.js`). This is the #38 contract the runtime
// must be drop-in for. Resolves once packages/sim-wasm/src/cosim.ts is present
// in the merged tree (it ships on the #38 / hermetic build side).
import {
  CoSimOrchestrator,
  type AnalogEngine,
  type FirmwareModel,
  type PinBinding,
} from "../../../sim-wasm/src/cosim.js";
import { createRuntime, adcAndOutput } from "../support/runtime.js";
import { thermostatFirmware } from "../fixtures/firmware.js";

/**
 * Issue #37 — FirmwareModel compatibility + closed-loop co-sim.
 *
 * The real MicroPython runtime is injected into the REAL CoSimOrchestrator as
 * the FirmwareModel, alongside a small analytic AnalogEngine. Across ticks the
 * loop must close end-to-end: firmware GPIO change -> analog re-solve -> ADC
 * change -> firmware's Python branch reacts. A stub firmware cannot drive this
 * (its output would not track the fed-back ADC); a wall-clock runtime would
 * break the deterministic trace.
 */

const ADC = 26;
const HEATER = 15;
const THRESHOLD = 16_000;

/**
 * Analytic heater: the GPIO-driven source `V_HEAT` raises the "sense" net to
 * half its drive voltage. Stands in for a real ngspice re-solve so the COUPLING
 * is exercised without WASM ngspice (same technique as sim-wasm's cosim.test.ts).
 */
const heaterAnalog: AnalogEngine = {
  async solve({ drives }) {
    const vheat = drives["V_HEAT"] ?? 0;
    return { voltages: { sense: 0.5 * vheat } };
  },
};

const BINDINGS: PinBinding[] = [
  { mcuPin: "26", net: "sense", direction: "input", vref: 3.3 },
  { mcuPin: "15", net: "sense", direction: "output", deviceId: "V_HEAT", vHigh: 3.3 },
];

describe("mpy-wasm: real MicroPython firmware drives the #38 co-sim loop", () => {
  it("is structurally a FirmwareModel and closes the GPIO<->ADC loop across ticks", async () => {
    const runtime = await createRuntime(
      thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: THRESHOLD }),
      adcAndOutput(ADC, HEATER),
    );

    // Compile-time drop-in proof (enforced by `npm run typecheck`): the runtime
    // is assignable to the #38 FirmwareModel interface.
    const asFirmwareModel: FirmwareModel = runtime;

    const cosim = new CoSimOrchestrator(heaterAnalog, asFirmwareModel, {
      runId: "mpy-cosim",
      stepMs: 1,
      durationMs: 4,
      bindings: BINDINGS,
    });

    const trace = await cosim.run();
    expect(trace).toHaveLength(5); // t=0 priming + 4 ticks

    // t=0 priming solve: heater off, sensor cold, no drive.
    expect(trace[0]!.gpio["15"]).toBe(0);
    expect(trace[0]!.adc["26"]).toBe(0);
    expect(trace[0]!.voltages.sense).toBe(0);

    // t=1: real Python saw the cold reading and turned the heater ON; the analog
    // RE-SOLVE with that drive raised the sensed voltage -> genuine coupling.
    expect(trace[1]!.gpio["15"]).toBe(1);
    expect(trace[1]!.adc["26"]).toBeGreaterThan(0);
    expect(trace[1]!.voltages.sense).toBeCloseTo(1.65, 2);

    // t=2: the firmware reacted to the now-warm fed-back reading and turned OFF.
    expect(trace[2]!.gpio["15"]).toBe(0);
    expect(trace[2]!.voltages.sense).toBe(0);

    // bang-bang continues deterministically.
    expect(trace[3]!.gpio["15"]).toBe(1);
    expect(trace[4]!.gpio["15"]).toBe(0);

    // virtual time advanced by stepMs each tick (seconds in the trace).
    expect(trace[1]!.simTime).toBeCloseTo(0.001, 6);
    expect(trace[2]!.simTime).toBeCloseTo(0.002, 6);
    expect(cosim.getSimTimeSec()).toBeCloseTo(0.004, 6);
  });

  it("is deterministic when driven through the orchestrator twice", async () => {
    const build = async () => {
      const runtime = await createRuntime(
        thermostatFirmware({ adcPin: ADC, heaterPin: HEATER, threshold: THRESHOLD }),
        adcAndOutput(ADC, HEATER),
      );
      const cosim = new CoSimOrchestrator(heaterAnalog, runtime, {
        runId: "mpy-cosim-det",
        stepMs: 1,
        durationMs: 5,
        bindings: BINDINGS,
      });
      return cosim.run();
    };
    expect(await build()).toEqual(await build());
  });
});
