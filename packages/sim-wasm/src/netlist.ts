/**
 * Netlist preparation for the WASM engine.
 *
 * The netlists air-ts emits (#9) target NATIVE ngspice invoked with a `.control`
 * block that runs the sim and `wrdata`s CSVs to relative paths on the host
 * filesystem. The WASM engine (eecircuit-engine) supplies its OWN control
 * sequence (`source; destroy all; run; write out.raw`) and runs in an in-memory
 * emscripten filesystem with no host paths. Two constructs in the emitted
 * netlist therefore break the WASM run and must be removed before feeding it:
 *
 *   1. The `.control … .endc` block. Its `run` competes with eecircuit's own
 *      `run`, and its `wrdata ../waveforms/x.csv` targets a host path that does
 *      not exist in the WASM FS -> the run deadlocks. eecircuit already runs the
 *      analysis and captures every vector via `write out.raw`, so the block is
 *      redundant here.
 *   2. `.options filetype=ascii`. This makes ngspice write the rawfile in ASCII,
 *      but eecircuit reads `out.raw` as BINARY -> its parser hangs. The WASM
 *      engine must use the default (binary) rawfile.
 *
 * This is a TRANSPORT adaptation, not a semantic change: the devices, sources,
 * models, and `.tran`/`.op`/`.dc` analysis line are untouched, so the simulated
 * circuit — and therefore the result asserted against the corpus report — is
 * identical. See ADR 0011.
 */

/** Strip host-only `.control` blocks and the ASCII-rawfile option. */
export function prepareNetlist(netlist: string): string {
  let out = netlist;
  // Remove every `.control … .endc` block (multi-line, case-insensitive).
  out = out.replace(/^[ \t]*\.control\b[\s\S]*?^[ \t]*\.endc[ \t]*$/gim, "");
  // Remove `filetype=ascii` from any `.options` line (leave other options).
  out = out.replace(/[ \t]*\bfiletype\s*=\s*ascii\b/gi, "");
  // Drop a now-empty `.options` line (only whitespace after `.options`).
  out = out.replace(/^[ \t]*\.options[ \t]*$/gim, "");
  // Collapse the blank lines the removals leave behind (cosmetic; ngspice is
  // whitespace-tolerant, but keep the netlist tidy for the /sim-lab display).
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trimEnd() + "\n";
}
