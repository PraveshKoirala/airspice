/**
 * `run_cosim` wiring (issue #40) — an HONEST wrapper over the existing firmware
 * ⇄ analog co-simulation orchestrator (sim-wasm `CoSimOrchestrator`, ADR 0011).
 *
 * REGIME (stated plainly, not faked): the orchestrator couples domains by
 * re-solving the analog netlist per firmware I/O event. The analog domain here
 * is REAL ngspice (via the Node worker). The FIRMWARE domain — actually
 * executing the MCU's MicroPython/C++ to decide GPIO writes — needs the
 * mpy-wasm runtime (issue #37), which is not yet available. So this wrapper does
 * NOT invent firmware behaviour: it performs the real t=0 analog priming solve
 * (`orchestrator.initialize()`, which never steps firmware), reports the
 * resolved firmware pin bindings, and explicitly marks that zero firmware steps
 * were executed. When #37 lands it becomes the injected FirmwareModel and the
 * loop advances; nothing here fakes that today.
 *
 * All logic is delegated: air-ts resolves bindings + compiles the netlist,
 * sim-wasm's orchestrator + worker do the analog solve. This file only wires.
 */

import { parse, compileSpice, defaultNgspiceProfile, resolveBindings } from "air-ts";
import type { SystemIR } from "air-ts";
import { CoSimOrchestrator, createSimClientAnalogEngine } from "sim-wasm";
import type { PinBinding, FirmwareModel } from "sim-wasm";
import { simClient } from "./engine/simulate.js";

/** A firmware model that refuses to step — #37 is not here yet, so we never do. */
const PENDING_FIRMWARE: FirmwareModel = {
  step() {
    throw new Error(
      "Firmware execution requires the MicroPython WASM runtime (issue #37), " +
        "which is not yet available. Only the t=0 analog priming solve ran.",
    );
  },
};

export interface CosimResult {
  regime: string;
  firmware_runtime: "unavailable_pending_mpy_wasm_37";
  firmware_steps_executed: 0;
  bindings: Array<{
    id: string;
    signal: string;
    component: string;
    peripheral: string;
    channel: string;
    net: string;
    mcu_pin: string | null;
    direction: "input";
  }>;
  analog_prime: {
    ran: boolean;
    note: string;
    sim_time_s?: number;
    voltages?: Record<string, number>;
    adc?: Record<string, number>;
  };
}

/**
 * Run the honest t=0 co-sim priming for a firmware design. Throws with a clear
 * message when the design has no <firmware> block (the tool should not be listed
 * in that case, but we defend anyway).
 */
export async function runCosim(xml: string, signal: AbortSignal): Promise<CosimResult> {
  const ir: SystemIR = parse(xml);
  if (!hasFirmware(ir)) {
    throw new Error("This design has no <firmware> block; run_cosim does not apply.");
  }

  const resolved = resolveBindings(ir);
  const bindings = resolved.map((b) => ({
    id: b.id,
    signal: b.signal,
    component: b.component,
    peripheral: b.peripheral,
    channel: b.channel,
    net: b.net,
    mcu_pin: b.pinName,
    direction: "input" as const,
  }));

  const result: CosimResult = {
    regime:
      "quasi-static event-driven co-sim (ADR 0011); analog = real ngspice, " +
      "firmware stepping pending mpy-wasm (#37)",
    firmware_runtime: "unavailable_pending_mpy_wasm_37",
    firmware_steps_executed: 0,
    bindings,
    analog_prime: { ran: false, note: "" },
  };

  // The real t=0 analog priming solve needs a default ngspice profile + test.
  const profileId = defaultNgspiceProfile(ir);
  if (profileId === null) {
    result.analog_prime.note =
      "No default ngspice profile in this design, so no analog priming solve was run.";
    return result;
  }
  const profile = ir.simulation_profiles.get(profileId);
  const testId = profile?.tests[0];
  const test = testId ? ir.tests.get(testId) : undefined;
  if (!test) {
    result.analog_prime.note =
      "The default profile has no runnable test, so no analog priming solve was run.";
    return result;
  }

  // Compile once; at t=0 no firmware GPIO output is driven, so the netlist is the
  // as-compiled test deck (buildNetlist ignores the empty drive set).
  const { netlist } = compileSpice(ir, test);
  const inputNets = [...new Set(resolved.map((b) => b.net))];
  const pinBindings: PinBinding[] = resolved.map((b) => ({
    mcuPin: b.pinName ?? b.channel ?? b.signal,
    net: b.net,
    direction: "input",
    vref: 3.3,
  }));

  const analog = createSimClientAnalogEngine(simClient(), () => netlist, inputNets);
  const orchestrator = new CoSimOrchestrator(analog, PENDING_FIRMWARE, {
    runId: "mcp-cosim",
    bindings: pinBindings,
  });

  if (signal.aborted) {
    result.analog_prime.note = "Aborted before the analog priming solve.";
    return result;
  }

  // initialize() performs ONE real analog solve at t=0 and reads inputs back to
  // ADC; it never calls firmware.step(), so no firmware behaviour is invented.
  const state = await orchestrator.initialize();
  result.analog_prime = {
    ran: true,
    note:
      "Real ngspice t=0 operating solve. Input-net voltages read back as ADC " +
      "codes (0..65535 over vref). No firmware steps were executed.",
    sim_time_s: state.simTime,
    voltages: state.voltages,
    adc: state.adc,
  };
  return result;
}

/** True when the design declares any firmware project (the run_cosim gate). */
export function hasFirmware(ir: SystemIR): boolean {
  return ir.firmware_projects.size > 0;
}
