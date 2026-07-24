/**
 * Control-capable ngspice-WASM engine (issue #88) — Node loader + typed wrapper.
 *
 * Wraps the `ngshared` build (ngspice-46, --with-ngshared, no ASYNCIFY; see
 * Dockerfile.ngshared) behind a clean API centered on SYNCHRONOUS control:
 *
 *   - setSourceProvider(fn): fn(node, timeSec) -> volts. Registered as ngspice's
 *     GetVSRCData; ngspice calls it for each controlled source at every timepoint of a
 *     continuous transient. This is how firmware GPIO drives the analog domain WITHOUT
 *     halting the run — the #88 capability (ADR 0011 update, 2026-07-24).
 *   - onTimepoint(fn): fn({time, get(name)}) at each accepted timepoint (SendData); this
 *     is how the analog domain feeds the firmware's ADC.
 *
 * Encapsulates the two non-obvious runtime requirements: provide the wasm binary
 * directly (the build targets web/worker and would otherwise fetch()), and install a
 * fake /proc/meminfo (or ngspice's memory sizing overflows to a 1 GB alloc and aborts).
 *
 * Browser/worker packaging is a separate step; this is the Node path used by the
 * co-sim orchestrator and its tests.
 */
import { createRequire } from "node:module";
import { readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MEMINFO = "MemTotal:        4194304 kB\nMemFree:         3670016 kB\nMemAvailable:    3670016 kB\n";

/**
 * @param {{ jsPath: string, wasmPath?: string }} opts
 * @returns {Promise<ControlEngine>}
 */
export async function createControlEngine(opts) {
  const jsPath = opts.jsPath;
  const wasmPath = opts.wasmPath || jsPath.replace(/\.js$/, ".wasm");
  // The emitted glue is CJS/UMD; copy to a neutral .cjs so require() yields the factory
  // even under a type:module package.
  const cjs = join(tmpdir(), `ngshared-eng-${process.pid}-${Math.abs(hash(jsPath))}.cjs`);
  copyFileSync(jsPath, cjs);
  const factory = require(cjs);
  const wasmBinary = readFileSync(wasmPath);

  const msgs = [];
  const M = await factory({ wasmBinary, print: (s) => msgs.push(s), printErr: (s) => msgs.push("E:" + s) });
  const S = (p) => (p ? M.UTF8ToString(p) : "");

  // Callbacks. Signatures per sharedspice.h; wrong arity traps as `unreachable`.
  let sourceProvider = null; // (node, timeSec) => volts
  let timepointCb = null;    // ({time, get}) => void

  const SendChar = M.addFunction((p) => { msgs.push(S(p)); return 0; }, "iiii");
  const SendStat = M.addFunction(() => 0, "iiii");
  const ControlledExit = M.addFunction((st) => { msgs.push("EXIT:" + st); return 0; }, "iiiiii");
  const SendData = M.addFunction((allp) => {
    if (!timepointCb) return 0;
    const count = M.getValue(allp + 0, "i32");
    const vecsa = M.getValue(allp + 8, "i32");
    const row = new Map();
    let time = null;
    for (let i = 0; i < count; i++) {
      const vv = M.getValue(vecsa + i * 4, "i32");
      const name = S(M.getValue(vv + 0, "i32"));
      const creal = M.getValue(vv + 8, "double");
      row.set(name.toLowerCase(), creal);
      if (name.toLowerCase() === "time") time = creal;
    }
    timepointCb({ time, get: (n) => row.get(String(n).toLowerCase()) });
    return 0;
  }, "iiiii");
  const SendInitData = M.addFunction(() => 0, "iiii");
  const BGThreadRunning = M.addFunction(() => 0, "iiii");
  M.ccall("ngSpice_Init", "number", Array(7).fill("number"),
    [SendChar, SendStat, ControlledExit, SendData, SendInitData, BGThreadRunning, 0]);

  // The 1 GB-alloc guard.
  try { M.FS.mkdir("/proc"); } catch (e) { /* exists */ }
  M.FS.writeFile("/proc/meminfo", MEMINFO);

  // GetVSRCData(double* volt, double time, char* node, int ident, void*) -> int
  const GetVSRCData = M.addFunction((voltPtr, time, nodePtr, ident, user) => {
    const v = sourceProvider ? sourceProvider(S(nodePtr), time) : 0;
    M.setValue(voltPtr, Number(v) || 0, "double");
    return 0;
  }, "iidiii");
  const GetISRCData = M.addFunction(() => 0, "iidiii");
  M.ccall("ngSpice_Init_Sync", "number", Array(5).fill("number"), [GetVSRCData, GetISRCData, 0, 0, 0]);

  const command = (cmd) => M.ccall("ngSpice_Command", "number", ["string"], [cmd]);

  /** @typedef {object} ControlEngine */
  return {
    /** Load a netlist (array of lines). Returns ngspice rc (0 = ok). */
    loadCircuit(lines) {
      const ptrs = lines.map((l) => { const n = Buffer.byteLength(l, "utf8") + 1; const p = M._malloc(n); M.stringToUTF8(l, p, n); return p; });
      const arr = M._malloc((ptrs.length + 1) * 4);
      ptrs.forEach((p, i) => M.setValue(arr + i * 4, p, "i32"));
      M.setValue(arr + ptrs.length * 4, 0, "i32");
      return M.ccall("ngSpice_Circ", "number", ["number"], [arr]);
    },
    /** fn(node, timeSec) -> volts, called by ngspice for controlled sources each timepoint. */
    setSourceProvider(fn) { sourceProvider = fn; },
    /** fn({time, get(name)}) at each accepted transient timepoint. */
    onTimepoint(fn) { timepointCb = fn; },
    /** Run the loaded analysis (synchronous). Returns ngspice rc. */
    run() { return command("run"); },
    command,
    /** Read a result vector's last value (NaN if absent). */
    lastValue(name) {
      const vp = M.ccall("ngGet_Vec_Info", "number", ["string"], [name]);
      if (!vp) return NaN;
      const real = M.getValue(vp + 12, "i32");
      const len = M.getValue(vp + 20, "i32");
      return (real && len) ? M.getValue(real + (len - 1) * 8, "double") : NaN;
    },
    /** Recent ngspice stdout/stderr lines (diagnostics). */
    messages() { return msgs.slice(); },
    _module: M,
  };
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
