/**
 * Issue #88 / M8 — FULL-STACK co-sim: REAL MicroPython firmware ⇄ REAL ngspice.
 *
 * The capstone. No injected/analytic firmware: an actual bang-bang thermostat written in
 * Python runs on the mpy-wasm MicroPython WASM runtime (#37), and its heater decision
 * drives a real ngspice-46 transient through the control engine's synchronous GetVSRCData
 * path (#88). One continuous transient; reactive state preserved. The Python interpreter
 * itself decides the heater from the sensed voltage — a stub cannot reproduce it (flip the
 * threshold and the regulation point moves).
 *
 * mpy-wasm step() is SYNCHRONOUS, so it runs directly inside ngspice's SendData callback —
 * no ASYNCIFY, no async bridge.
 *
 * Run: node packages/sim-wasm/src/node/realfirmware-cosim.test.mjs [path-to-ngshared.js]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createControlEngine } from "./ngshared-engine.mjs";
import { createTransientCoSim } from "./transient-cosim.mjs";
import { createNodeRuntime } from "../../../mpy-wasm/dist/node/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const jsPath = process.argv[2] || join(resolve(HERE, "../../../.."), "build-out", "ngshared.js");
if (!existsSync(jsPath)) { console.error(`ENGINE NOT FOUND: ${jsPath}`); process.exit(2); }

const VREF = 3.3;
const SETPOINT_V = 1.0;
const THRESHOLD = Math.round((SETPOINT_V / VREF) * 65535); // ADC counts for the Python constant

// REAL MicroPython firmware: Arduino-style setup()/loop(), ADC(4) sensor, Pin(5) heater.
const firmwareSource = [
  "import machine",
  "_sensor = machine.ADC(4)",
  "_heater = machine.Pin(5, machine.Pin.OUT)",
  `THRESHOLD = ${THRESHOLD}`,
  "def setup():",
  "    _heater.value(0)",
  "def loop():",
  "    reading = _sensor.read_u16()",
  "    if reading < THRESHOLD:",
  "        _heater.value(1)",
  "    else:",
  "        _heater.value(0)",
  "",
].join("\n");

// mcuPin keys must match the Python Pin ids ("4" sensor, "5" heater).
const cosimBindings = [
  { mcuPin: "4", net: "temp", direction: "input", vref: VREF },
  { mcuPin: "5", net: "hin", direction: "output", deviceId: "V_HEAT", vHigh: 3.3 },
];
const netlist = [
  "* thermostat plant", "V_HEAT hin 0 external", "R_H hin temp 1k", "C_T temp 0 10u", "R_LEAK temp 0 1k",
  ".tran 50u 60m uic", ".end",
];

let ok = true;
const check = (name, pass, detail) => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok = ok && pass; };

async function runWithThreshold(engineJs, thresholdCounts) {
  const src = firmwareSource.replace(/THRESHOLD = \d+/, `THRESHOLD = ${thresholdCounts}`);
  const fw = createNodeRuntime();
  await fw.init(src, [{ mcuPin: "4", direction: "input" }, { mcuPin: "5", direction: "output" }]);
  const engine = await createControlEngine({ jsPath: engineJs });
  const cosim = createTransientCoSim({ engine, firmware: fw, bindings: cosimBindings, sampleMs: 1 });
  return cosim.run(netlist);
}

(async () => {
  console.log(`engine: ${jsPath}\nREAL MicroPython thermostat, setpoint ${SETPOINT_V}V (${THRESHOLD} counts)\n`);

  const trace = await runWithThreshold(jsPath, THRESHOLD);
  const temps = trace.map((s) => s.voltages.temp).filter(Number.isFinite);
  let toggles = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i].gpio["5"] !== trace[i - 1].gpio["5"]) toggles++;
  const tail = temps.slice(Math.floor(temps.length / 2));
  const mean = tail.reduce((a, b) => a + b, 0) / (tail.length || 1);

  check("real MicroPython firmware ran in-loop and toggled the heater", toggles >= 3, `${toggles} toggles over ${trace.length} samples`);
  check("closed loop regulates temp near the Python setpoint", mean > 0.7 && mean < 1.4, `settled mean=${mean.toFixed(3)}V (setpoint ${SETPOINT_V}V)`);

  // Anti-stub: RAISE the Python threshold constant; the real interpreter must regulate HIGHER.
  const highThresh = Math.round((1.4 / VREF) * 65535);
  const trace2 = await runWithThreshold(jsPath, highThresh);
  const t2 = trace2.map((s) => s.voltages.temp).filter(Number.isFinite);
  const mean2 = t2.slice(Math.floor(t2.length / 2)).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(t2.length / 2));
  check("Python threshold constant actually drives the decision (anti-stub)", mean2 > mean + 0.15,
    `low-thresh mean=${mean.toFixed(3)}V vs high-thresh mean=${mean2.toFixed(3)}V (higher setpoint -> higher regulated temp)`);

  console.log(`\n${ok ? "✅ FULL STACK: real MicroPython firmware ⇄ real ngspice-46, transient-preserving co-sim WORKS" : "❌ full-stack co-sim failed"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("full-stack cosim fatal:", e); process.exit(3); });
