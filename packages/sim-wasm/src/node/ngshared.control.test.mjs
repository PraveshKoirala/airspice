/**
 * Issue #88 — control-capable ngspice-WASM: real capability verification.
 *
 * Proves, by DRIVING the actual engine, that the ngshared build can:
 *   (0) run a normal transient (fire-and-forget), and
 *   (1) let JS control a voltage source mid-transient, in ONE continuous run, with
 *       reactive state PRESERVED across the change — genuine transient-preserving
 *       co-simulation. A quasi-static re-solve physically cannot pass test (1): the
 *       capacitor must discharge FROM its charged state after the source steps.
 *
 * Mechanism (the #88 result): control is NOT halt/alter/resume + ASYNCIFY (that is a
 * dead end — ASYNCIFY is incompatible with ngspice's setjmp/longjmp). It is the
 * SYNCHRONOUS ngSpice_Init_Sync / GetVSRCData callback: ngspice asks the host for the
 * controlled source's value at every timepoint of a continuous transient.
 *
 * Two build/runtime facts this encodes:
 *   - the engine is built WITHOUT ASYNCIFY (SUPPORT_LONGJMP=wasm + -fwasm-exceptions);
 *   - a fake /proc/meminfo must be provided or ngspice's memory sizing blows up to a
 *     1 GB alloc and aborts the run.
 *
 * Run: node packages/sim-wasm/src/node/ngshared.control.test.mjs [path-to-ngshared.js]
 * Default engine: ./build-out/ngshared.js  (built from Dockerfile.ngshared).
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const engineJs = process.argv[2] || join(REPO, "build-out", "ngshared.js");
const engineWasm = engineJs.replace(/\.js$/, ".wasm");
if (!existsSync(engineJs) || !existsSync(engineWasm)) {
  console.error(`ENGINE NOT FOUND: ${engineJs}\nBuild it: podman build -f Dockerfile.ngshared -t ngshared-builder:modern <ctx-with-tarball>`);
  process.exit(2);
}
// Emitted glue is CJS/UMD; copy to a neutral .cjs so require() returns the factory even
// when the nearest package.json is type:module.
const cjs = join(tmpdir(), `ngshared-${process.pid}.cjs`);
copyFileSync(engineJs, cjs);
const factory = require(cjs);
const wasmBinary = readFileSync(engineWasm);

const MEMINFO = "MemTotal:        4194304 kB\nMemFree:         3670016 kB\nMemAvailable:    3670016 kB\n";

async function newEngine() {
  const msgs = [];
  const M = await factory({ wasmBinary, print: (s) => msgs.push(s), printErr: (s) => msgs.push("E:" + s) });
  const S = (p) => (p ? M.UTF8ToString(p) : "");
  const cb = (fn, sig) => M.addFunction(fn, sig);
  const traj = [];
  const SendData = cb((allp) => {
    const count = M.getValue(allp + 0, "i32"), vecsa = M.getValue(allp + 8, "i32");
    let t = null, vout = null;
    for (let i = 0; i < count; i++) { const vv = M.getValue(vecsa + i * 4, "i32"); const nm = S(M.getValue(vv + 0, "i32")).toLowerCase(); const val = M.getValue(vv + 8, "double"); if (nm === "time") t = val; else if (nm === "out") vout = val; }
    if (t != null) traj.push({ t, vout });
    return 0;
  }, "iiiii");
  M.ccall("ngSpice_Init", "number", Array(7).fill("number"),
    [cb((p) => { msgs.push(S(p)); return 0; }, "iiii"), cb(() => 0, "iiii"), cb((st) => { msgs.push("EXIT:" + st); return 0; }, "iiiiii"), SendData, cb(() => 0, "iiii"), cb(() => 0, "iiii"), 0]);
  try { M.FS.mkdir("/proc"); } catch (e) {}
  M.FS.writeFile("/proc/meminfo", MEMINFO);

  const loadCirc = (lines) => {
    const ptrs = lines.map((l) => { const n = Buffer.byteLength(l, "utf8") + 1; const p = M._malloc(n); M.stringToUTF8(l, p, n); return p; });
    const arr = M._malloc((ptrs.length + 1) * 4);
    ptrs.forEach((p, i) => M.setValue(arr + i * 4, p, "i32")); M.setValue(arr + ptrs.length * 4, 0, "i32");
    return M.ccall("ngSpice_Circ", "number", ["number"], [arr]);
  };
  const run = () => M.ccall("ngSpice_Command", "number", ["string"], ["run"]);
  const lastValue = (name) => { const vp = M.ccall("ngGet_Vec_Info", "number", ["string"], [name]); if (!vp) return NaN; const real = M.getValue(vp + 12, "i32"), len = M.getValue(vp + 20, "i32"); return (real && len) ? M.getValue(real + (len - 1) * 8, "double") : NaN; };
  const initSync = (getV) => M.ccall("ngSpice_Init_Sync", "number", Array(5).fill("number"), [M.addFunction(getV, "iidiii"), M.addFunction(() => 0, "iidiii"), 0, 0, 0]);
  const setDouble = (ptr, v) => M.setValue(ptr, v, "double");
  return { M, S, msgs, traj, loadCirc, run, lastValue, initSync, setDouble };
}

const near = (a, b, rtol, atol = 0) => Math.abs(a - b) <= atol + rtol * Math.abs(b);
let ok = true;
const check = (name, pass, detail) => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok = ok && pass; };

const RC = ["R1 in out 1k", "C1 out 0 1u"]; // tau = 1 ms

(async () => {
  console.log(`engine: ${engineJs}\n`);

  // Test 0: fire-and-forget transient (proves the engine computes at all).
  {
    const e = await newEngine();
    e.loadCirc(["* ff", "V1 in 0 5", ...RC, ".tran 10u 5m", ".end"]);
    const rc = e.run();
    const vout = e.lastValue("out");
    // 5 ms = 5 tau -> ~5 * (1 - e^-5) = 4.966 V
    check("fire-and-forget transient runs and computes RC charge", rc === 0 && e.traj.length > 100 && near(vout, 4.966, 0.02),
      `rc=${rc}, ${e.traj.length} pts, V(out,5ms)=${vout.toFixed(3)}V (expect ~4.97)`);
  }

  // Test 1: JS controls the source mid-transient; state must be preserved (charge THEN discharge).
  {
    const e = await newEngine();
    const seen = {};
    let calls = 0;
    e.initSync((voltPtr, time, nodePtr, ident, user) => {
      calls++; const node = e.S(nodePtr); seen[node] = (seen[node] || 0) + 1;
      e.setDouble(voltPtr, time < 2.5e-3 ? 5.0 : 0.0); // "firmware": 5V then 0V at 2.5ms
      return 0;
    });
    e.loadCirc(["* controlled", "V1 in 0 external", ...RC, ".tran 10u 5m uic", ".end"]);
    const rc = e.run();
    const at = (target) => e.traj.reduce((a, b) => Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a, e.traj[0] || { vout: NaN });
    const peak = at(2.5e-3).vout, final = at(5e-3).vout;
    // Analytic: peak = 5(1-e^-2.5)=4.59 ; final = 4.59*e^-2.5 = 0.377
    const controlled = calls > 0 && (seen["v1"] || 0) > 0;
    const peakOk = near(peak, 4.59, 0.03);
    const dischargeOk = near(final, 0.377, 0, 0.1) && final < peak; // preserved-state discharge
    check("GetVSRCData drove the source every timepoint", controlled, `${calls} calls, nodes=${JSON.stringify(seen)}`);
    check("transient-preserving control: charge to ~4.59V then discharge to ~0.38V", rc === 0 && peakOk && dischargeOk,
      `peak(2.5ms)=${Number.isFinite(peak) ? peak.toFixed(3) : "?"}V, final(5ms)=${Number.isFinite(final) ? final.toFixed(3) : "?"}V`);
  }

  console.log(`\n${ok ? "✅ #88 CAPABILITY VERIFIED: ngspice-WASM is control-capable (synchronous GetVSRCData, transient-preserving)" : "❌ #88 NOT verified"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("harness fatal:", e); process.exit(3); });
