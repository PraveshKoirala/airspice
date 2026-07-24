/**
 * Issue #88 — control-capable ngspice-WASM: capability verification.
 *
 * Drives the reusable engine wrapper (./ngshared-engine.mjs) to prove the ngshared build:
 *   (0) runs a normal transient, and
 *   (1) lets JS control a source mid-transient, in ONE continuous run, with reactive
 *       state PRESERVED — genuine transient-preserving co-sim. Quasi-static re-solve
 *       physically cannot pass (1): the capacitor must discharge FROM its charged state.
 *
 * Control is the SYNCHRONOUS ngSpice_Init_Sync/GetVSRCData path (no ASYNCIFY — that is a
 * dead end for ngspice's setjmp/longjmp; see ADR 0011 update).
 *
 * Run: node packages/sim-wasm/src/node/ngshared.control.test.mjs [path-to-ngshared.js]
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createControlEngine } from "./ngshared-engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const jsPath = process.argv[2] || join(REPO, "build-out", "ngshared.js");
if (!existsSync(jsPath) || !existsSync(jsPath.replace(/\.js$/, ".wasm"))) {
  console.error(`ENGINE NOT FOUND: ${jsPath}\nBuild it: podman build -f Dockerfile.ngshared -t ngshared-builder:modern <ctx-with-tarball>`);
  process.exit(2);
}

const near = (a, b, rtol, atol = 0) => Math.abs(a - b) <= atol + rtol * Math.abs(b);
let ok = true;
const check = (name, pass, detail) => { console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); ok = ok && pass; };
const RC = ["R1 in out 1k", "C1 out 0 1u"]; // tau = 1 ms

(async () => {
  console.log(`engine: ${jsPath}\n`);

  // Test 0: fire-and-forget transient.
  {
    const e = await createControlEngine({ jsPath });
    const pts = [];
    e.onTimepoint(({ time, get }) => pts.push({ t: time, vout: get("out") }));
    e.loadCircuit(["* ff", "V1 in 0 5", ...RC, ".tran 10u 5m", ".end"]);
    const rc = e.run();
    const vout = e.lastValue("out"); // 5 ms = 5 tau -> ~4.97 V
    check("fire-and-forget transient runs and computes RC charge", rc === 0 && pts.length > 100 && near(vout, 4.966, 0.02),
      `rc=${rc}, ${pts.length} pts, V(out,5ms)=${vout.toFixed(3)}V (expect ~4.97)`);
  }

  // Test 1: JS controls the source mid-transient; state preserved (charge THEN discharge).
  {
    const e = await createControlEngine({ jsPath });
    const traj = [];
    const seen = new Set();
    let calls = 0;
    e.setSourceProvider((node, timeSec) => { calls++; seen.add(node); return timeSec < 2.5e-3 ? 5.0 : 0.0; });
    e.onTimepoint(({ time, get }) => { if (time != null) traj.push({ t: time, vout: get("out") }); });
    e.loadCircuit(["* controlled", "V1 in 0 external", ...RC, ".tran 10u 5m uic", ".end"]);
    const rc = e.run();
    const at = (target) => traj.reduce((a, b) => Math.abs(b.t - target) < Math.abs(a.t - target) ? b : a, traj[0] || { vout: NaN });
    const peak = at(2.5e-3).vout, final = at(5e-3).vout;
    check("GetVSRCData drove the source every timepoint", calls > 0 && seen.has("v1"), `${calls} calls, nodes=${[...seen]}`);
    // Analytic: peak = 5(1-e^-2.5)=4.59 ; final = 4.59*e^-2.5 = 0.377
    check("transient-preserving control: charge to ~4.59V then discharge to ~0.38V",
      rc === 0 && near(peak, 4.59, 0.03) && near(final, 0.377, 0, 0.1) && final < peak,
      `peak(2.5ms)=${Number.isFinite(peak) ? peak.toFixed(3) : "?"}V, final(5ms)=${Number.isFinite(final) ? final.toFixed(3) : "?"}V`);
  }

  console.log(`\n${ok ? "✅ #88 CAPABILITY VERIFIED: ngspice-WASM is control-capable (synchronous GetVSRCData, transient-preserving)" : "❌ #88 NOT verified"}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("harness fatal:", e); process.exit(3); });
