import { describe, it, expect } from "vitest";
import {
  CoSimOrchestrator,
  createSimClientAnalogEngine,
  type AnalogEngine,
  type FirmwareModel,
} from "../../src/cosim.js";
import type { SimEvent, WaveTable } from "../../src/protocol.js";

/**
 * A deterministic analytic analog model: a resistive heater driven by V_HEAT
 * raises the "sense" node to half the drive voltage. This stands in for a real
 * ngspice re-solve so the COUPLING loop is exercised without WASM.
 */
const heaterAnalog: AnalogEngine = {
  async solve({ drives }) {
    const vheat = drives["V_HEAT"] ?? 0;
    return { voltages: { sense: 0.5 * vheat } };
  },
};

/** Bang-bang thermostat firmware: heat when the sensor reads cold. */
const thermostat: FirmwareModel = {
  step({ adc }) {
    const reading = adc["ADC0"] ?? 0;
    return { gpio: { HEAT: reading < 16000 ? 1 : 0 } };
  },
};

function makeOrchestrator(durationMs = 4) {
  return new CoSimOrchestrator(heaterAnalog, thermostat, {
    runId: "cosim-test",
    stepMs: 1,
    durationMs,
    bindings: [
      { mcuPin: "ADC0", net: "sense", direction: "input", vref: 3.3 },
      { mcuPin: "HEAT", net: "sense", direction: "output", deviceId: "V_HEAT", vHigh: 3.3 },
    ],
  });
}

describe("Milestone M8: CoSimOrchestrator — real lockstep coupling", () => {
  it("translates analog voltage to MicroPython uint16 ADC values", () => {
    const cosim = makeOrchestrator();
    expect(cosim.translateVoltageToAdc(0.0, 3.3)).toBe(0);
    expect(cosim.translateVoltageToAdc(3.3, 3.3)).toBe(65535);
    expect(cosim.translateVoltageToAdc(1.65, 3.3)).toBe(32768);
    // clamps out-of-range voltages.
    expect(cosim.translateVoltageToAdc(5.0, 3.3)).toBe(65535);
    expect(cosim.translateVoltageToAdc(-1.0, 3.3)).toBe(0);
  });

  it("closes the loop: a firmware GPIO change actually moves the ADC readback", async () => {
    const cosim = makeOrchestrator(4);
    const trace = await cosim.run();

    // t=0 priming solve: heater off, sensor cold.
    expect(trace[0]!.gpio.HEAT).toBe(0);
    expect(trace[0]!.adc.ADC0).toBe(0);
    expect(trace[0]!.voltages.sense).toBe(0);

    // t=1: firmware saw a cold reading and turned the heater ON, and the analog
    // RE-SOLVE with that drive raised the sensed voltage — genuine coupling, not
    // a spy on an ignored control message.
    expect(trace[1]!.gpio.HEAT).toBe(1);
    expect(trace[1]!.adc.ADC0).toBeGreaterThan(trace[0]!.adc.ADC0 ?? 0);
    expect(trace[1]!.voltages.sense).toBeCloseTo(1.65, 2);

    // t=2: firmware reacted to the now-warm reading and turned the heater OFF.
    expect(trace[2]!.gpio.HEAT).toBe(0);
    expect(trace[2]!.voltages.sense).toBe(0);
  });

  it("advances virtual time deterministically without wall-clock time", async () => {
    const a = makeOrchestrator(3);
    const b = makeOrchestrator(3);
    const ta = await a.run();
    const tb = await b.run();
    // identical inputs -> identical trace (no Date.now / Math.random anywhere).
    expect(ta).toEqual(tb);
    expect(ta[1]!.simTime).toBeCloseTo(0.001, 6);
    expect(ta[2]!.simTime).toBeCloseTo(0.002, 6);
    expect(a.getSimTimeSec()).toBeCloseTo(0.003, 6);
  });

  it("production adapter re-solves via a SimClient and reads back node voltages", async () => {
    // Stub SimClient.run yielding a real result event with a wave table.
    const fakeClient = {
      run(req: { id: string; netlist: string; probes?: unknown }): AsyncIterable<SimEvent> {
        const tables: WaveTable[] = [
          { name: "v(sense)", unit: "voltage", values: new Float64Array([0, 2.5]) },
        ];
        return {
          async *[Symbol.asyncIterator]() {
            yield { id: req.id, type: "result", tables } as SimEvent;
          },
        };
      },
    };
    let seenNetlist = "";
    const engine = createSimClientAnalogEngine(
      fakeClient,
      (drives) => {
        seenNetlist = `* cosim\nV_HEAT sense 0 DC ${drives["V_HEAT"] ?? 0}\n.op\n.end`;
        return seenNetlist;
      },
      ["sense"],
    );
    const out = await engine.solve({ drives: { V_HEAT: 3.3 }, timeMs: 7 });
    expect(out.voltages.sense).toBeCloseTo(2.5, 6);
    // the drive voltage was templated into the re-solved netlist.
    expect(seenNetlist).toContain("V_HEAT sense 0 DC 3.3");
  });

  it("surfaces an analog solve error instead of silently continuing", async () => {
    const failing = {
      run(req: { id: string }): AsyncIterable<SimEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: req.id,
              type: "error",
              diagnostic: {
                code: "SIM-SINGULAR-MATRIX",
                message: "singular matrix",
                hint: "",
                severity: "error",
                raw: "singular matrix",
              },
            } as SimEvent;
          },
        };
      },
    };
    const engine = createSimClientAnalogEngine(failing, () => "* x\n.end", ["sense"]);
    await expect(engine.solve({ drives: {}, timeMs: 0 })).rejects.toThrow(/singular matrix/);
  });
});
