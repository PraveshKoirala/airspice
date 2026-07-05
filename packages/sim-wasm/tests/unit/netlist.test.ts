/**
 * prepareNetlist tests: the WASM-engine transport adaptation. Verifies the
 * host-only `.control` block and the ascii-rawfile option are removed while the
 * devices/models/analysis line are preserved (so the simulated circuit is
 * unchanged). See netlist.ts / ADR 0011.
 */

import { describe, it, expect } from "vitest";
import { prepareNetlist } from "../../src/netlist";

describe("prepareNetlist", () => {
  it("strips a .control ... .endc block", () => {
    const out = prepareNetlist(
      [
        "V1 in 0 DC 5",
        "R1 in mid 10k",
        ".tran 1u 5m",
        ".control",
        "run",
        "wrdata ../waveforms/x.csv v(mid)",
        ".endc",
        ".end",
      ].join("\n"),
    );
    expect(out).not.toMatch(/\.control/i);
    expect(out).not.toMatch(/wrdata/i);
    expect(out).not.toMatch(/\.endc/i);
    // Devices + analysis survive.
    expect(out).toMatch(/V1 in 0 DC 5/);
    expect(out).toMatch(/\.tran 1u 5m/);
  });

  it("removes filetype=ascii but keeps other options", () => {
    expect(prepareNetlist(".options filetype=ascii reltol=1e-4\nV1 a 0 1\n.end")).toMatch(
      /\.options\s+reltol=1e-4/,
    );
    // A .options line that ONLY had filetype=ascii is dropped entirely.
    expect(prepareNetlist(".options filetype=ascii\nV1 a 0 1\n.end")).not.toMatch(
      /\.options/,
    );
  });

  it("preserves a plain netlist with no host-only constructs", () => {
    const src = "V1 a 0 DC 1\nR1 a 0 1k\n.op\n.end\n";
    expect(prepareNetlist(src).trim()).toBe(src.trim());
  });

  it("leaves .model / .tran / device lines intact", () => {
    const out = prepareNetlist(
      ".model NMOS NMOS(Vto=1.5 Kp=1)\nM1 d g 0 0 NMOS\n.tran 1u 20m\n.control\nrun\n.endc\n.end",
    );
    expect(out).toMatch(/\.model NMOS NMOS\(Vto=1\.5 Kp=1\)/);
    expect(out).toMatch(/M1 d g 0 0 NMOS/);
    expect(out).toMatch(/\.tran 1u 20m/);
  });
});
