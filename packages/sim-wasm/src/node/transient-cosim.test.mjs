/**
 * Issue #88 / M8 — end-to-end transient-preserving co-sim test.
 *
 * A bang-bang thermostat FIRMWARE (injected #37-shape model) reads an analog "temp" node
 * and drives a heater source; the analog plant (heater -> RC -> leak) integrates
 * continuously. Proves the closed loop runs through the control engine with reactive
 * state preserved: the heater toggles in response to the sensed voltage, and temp
 * regulates around the setpoint instead of running away — behaviour a quasi-static
 * re-solve (which forgets the capacitor charge each tick) cannot produce.
 *
 * Run: node packages/sim-wasm/src/node/transient-cosim.test.mjs [path-to-ngshared.js]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createControlEngine } from "./ngshared-engine.mjs";
import { createTransientCoSim } from "./transient-cosim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const jsPath = process.argv[2] || join(resolve(HERE, "../../../.."), "build-out", "ngshared.js");
if (!existsSync(jsPath)) { console.error(`ENGINE NOT FOUND: ${jsPath}`); process.exit(2); }

const VREF = 3.3;
const SET_V = 1.0;                                  // setpoint in volts
const SET_ADC = Math.round((SET_V / VREF) * 65535); // threshold in ADC counts

// Bang-bang thermostat: heater ON while measured temp is below setpoint.
const thermostat = {
  step({ adc }) {
    const t = adc["P_TEMP"] ?? 0;
    return { gpio: { P_HEAT: t < SET_ADC ? 1 : 0 } };
  },
};

const bindings = [
  { mcuPin: "P_TEMP", net: "temp", direction: "input", vref: VREF },
  { mcuPin: "P_HEAT", net: "hin", direction: "output", deviceId: "V_HEAT", vHigh: 3.3 },
];

// Plant: heater source -> R -> C (temp) with a leak resistor to ground.
// Heater on -> temp rises toward 3.3*(1k/2k)=1.65V (tau≈5ms); off -> decays to 0 (tau≈10ms).
const netlist = [
  "* thermostat plant",
  "V_HEAT hin 0 external",
  "R_H hin temp 1k",
  "C_T temp 0 10u",
  "R_LEAK temp 0 1k",
  ".tran 50u 60m uic",
  ".end",
];

let ok = true;
const check = (name, pass, detail) => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok = ok && pass; };

(async () => {
  console.log(`engine: ${jsPath}\nsetpoint: ${SET_V}V (${SET_ADC} counts)\n`);
  const engine = await createControlEngine({ jsPath });
  const cosim = createTransientCoSim({ engine, firmware: thermostat, bindings, sampleMs: 1 });
  const trace = cosim.run(netlist);

  const temps = trace.map((s) => s.voltages.temp).filter((v) => Number.isFinite(v));
  let toggles = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i].gpio.P_HEAT !== trace[i - 1].gpio.P_HEAT) toggles++;
  const tail = temps.slice(Math.floor(temps.length / 2)); // second half (settled)
  const mean = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);
  const maxT = Math.max(...temps), minTail = Math.min(...tail);

  check("co-sim produced a full sample trace", trace.length >= 50, `${trace.length} samples`);
  check("firmware reacted to analog: heater toggled (closed loop)", toggles >= 3, `${toggles} heater toggles`);
  check("temp regulates around setpoint (does not run away)", mean > 0.7 && mean < 1.4 && maxT < 1.7,
    `settled mean=${mean.toFixed(3)}V (setpoint ${SET_V}V), peak=${maxT.toFixed(3)}V`);
  // Transient preservation: during an OFF stretch, temp must DECAY from a nonzero value
  // (a re-solve would snap it to steady state, not decay). Find an off-run and check it drops.
  let decayed = false;
  for (let i = 1; i < trace.length - 3; i++) {
    if (trace[i].gpio.P_HEAT === 0 && trace[i - 1].gpio.P_HEAT === 1) {
      const a = trace[i].voltages.temp, b = trace[Math.min(i + 3, trace.length - 1)].voltages.temp;
      if (a > 0.5 && b < a) { decayed = true; break; }
    }
  }
  check("transient-preserving: temp decays from its charged value when heater turns off", decayed,
    "found a heater-off stretch where temp decays (not reset)");

  console.log(`\n${ok ? "✅ transient-preserving firmware⇄analog co-sim WORKS end-to-end" : "❌ co-sim check failed"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("cosim test fatal:", e); process.exit(3); });
