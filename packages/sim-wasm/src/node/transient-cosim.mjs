/**
 * Transient-preserving firmware ⇄ analog co-simulation (issue #88 / M8).
 *
 * Unlike the quasi-static re-solve orchestrator (cosim.ts), this runs ONE continuous
 * ngspice transient and couples the firmware into it through the control engine's
 * synchronous callbacks:
 *
 *   - GetVSRCData (setSourceProvider): ngspice asks, per timepoint, for each MCU-driven
 *     source's voltage; we answer from the firmware's current GPIO state.
 *   - SendData (onTimepoint): at each accepted timepoint we read the bound input nets,
 *     and when the virtual clock crosses a firmware sample boundary we step the firmware
 *     (reads ADC, sets GPIO) — which changes the source values for subsequent timepoints.
 *
 * Reactive state (capacitor charge, inductor current) is preserved across firmware
 * decisions because the analog solve never restarts. That is the capability quasi-static
 * re-solve lacks. The firmware model is the #37 interface: step({timeMs, adc, gpio}) -> {gpio}.
 */

/** @typedef {{ mcuPin: string, net: string, direction: "input"|"output", deviceId?: string, vHigh?: number, vref?: number }} PinBinding */

function recordFrom(map) { const o = {}; for (const [k, v] of map) o[k] = v; return o; }
function voltageToAdc(v, vref) { const c = Math.max(0, Math.min(vref, v)); return Math.round((c / vref) * 65535); }

/**
 * @param {object} opts
 * @param {import("./ngshared-engine.mjs").ControlEngine} opts.engine  a loaded control engine
 * @param {{ step: (i:{timeMs:number, adc:Record<string,number>, gpio:Record<string,0|1>}) => ({gpio?:Record<string,0|1>}) }} opts.firmware
 * @param {PinBinding[]} opts.bindings
 * @param {number} [opts.sampleMs]  firmware sample interval (default 1)
 */
export function createTransientCoSim({ engine, firmware, bindings, sampleMs = 1 }) {
  const outputs = bindings.filter((b) => b.direction === "output" && b.deviceId);
  const inputs = bindings.filter((b) => b.direction === "input");
  const gpio = new Map(outputs.map((b) => [b.mcuPin, 0]));
  const adc = new Map(inputs.map((b) => [b.mcuPin, 0]));
  const byDevice = new Map(outputs.map((b) => [b.deviceId.toLowerCase(), b]));
  const trace = [];
  let nextSampleMs = 0;
  const EPS = 1e-12;

  // firmware GPIO -> driven source voltage (per controlled source, every timepoint)
  engine.setSourceProvider((node, _timeSec) => {
    const b = byDevice.get(String(node).toLowerCase());
    if (!b) return 0;
    return gpio.get(b.mcuPin) === 1 ? (b.vHigh ?? 3.3) : 0;
  });

  // analog -> firmware ADC, and step the firmware at each sample boundary
  engine.onTimepoint(({ time, get }) => {
    if (time == null) return;
    const timeMs = time * 1000;
    if (timeMs + EPS < nextSampleMs) return; // not a sample instant yet
    for (const b of inputs) adc.set(b.mcuPin, voltageToAdc(get(b.net) ?? 0, b.vref ?? 3.3));
    const out = firmware.step({ timeMs: nextSampleMs, adc: recordFrom(adc), gpio: recordFrom(gpio) });
    if (out && out.gpio) for (const [pin, lvl] of Object.entries(out.gpio)) if (gpio.has(pin)) gpio.set(pin, lvl === 1 ? 1 : 0);
    const volts = {}; for (const b of [...inputs, ...outputs]) volts[b.net] = get(b.net);
    trace.push({ tMs: nextSampleMs, adc: recordFrom(adc), gpio: recordFrom(gpio), voltages: volts });
    nextSampleMs += sampleMs;
  });

  return {
    /** Load the netlist and run the continuous co-sim transient. Returns the sample trace. */
    run(netlist) {
      const rc = engine.loadCircuit(netlist);
      if (rc !== 0) throw new Error(`ngSpice_Circ failed rc=${rc}: ${engine.messages().slice(-3).join(" | ")}`);
      const rrc = engine.run();
      if (rrc !== 0) throw new Error(`run failed rc=${rrc}: ${engine.messages().slice(-4).join(" | ")}`);
      return trace;
    },
    trace,
  };
}
