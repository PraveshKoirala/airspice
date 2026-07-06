/**
 * Browser convergence-ladder mechanics tests (issue #94).
 *
 * Verify:
 *   - CONVERGENCE_LADDER is byte-identical to simulator.py's tuple (same rungs,
 *     names, option tokens, order, relaxes flag on rung 4). This is the
 *     port-parity contract — if the native ladder changes, this test flags it.
 *   - `buildRungNetlist` prepends the rung's `.options` line for rungs >= 2
 *     and leaves rung 1 as the pure `prepareNetlist(base)` output.
 *   - `runConvergenceLadder` stops at the first converging rung and returns
 *     the winning rung + its result; walks all 4 rungs on terminal exhaustion.
 *
 * Real eecircuit behaviour is covered by the Playwright ui-sim spec; these
 * tests exercise the pure logic tier with a scripted `runOne` fake.
 */

import { describe, it, expect } from "vitest";
import {
  CONVERGENCE_LADDER,
  buildRungNetlist,
  runConvergenceLadder,
  type LadderRung,
  type RungOutcome,
} from "../../src/ladder";
import { prepareNetlist } from "../../src/netlist";

describe("CONVERGENCE_LADDER (port parity with simulator.py)", () => {
  it("has exactly 4 rungs in the fixed order", () => {
    expect(CONVERGENCE_LADDER).toHaveLength(4);
    expect(CONVERGENCE_LADDER.map((r) => r.rung)).toEqual([1, 2, 3, 4]);
  });

  it("rung 1 is 'as-written' with empty options and relaxes=false", () => {
    const r1 = CONVERGENCE_LADDER[0]!;
    expect(r1.name).toBe("as-written");
    expect(r1.options).toEqual([]);
    expect(r1.relaxes).toBe(false);
  });

  it("rung 2 is gmin stepping with the native option tokens", () => {
    // Byte-identical to simulator.py rung 2 tuple.
    const r2 = CONVERGENCE_LADDER[1]!;
    expect(r2.name).toBe("gmin stepping");
    expect(r2.options).toEqual(["gminsteps=1", "itl1=500"]);
    expect(r2.relaxes).toBe(false);
  });

  it("rung 3 is source stepping composing rung-2 aids", () => {
    const r3 = CONVERGENCE_LADDER[2]!;
    expect(r3.name).toBe("source stepping");
    // Order matters: srcsteps first (rung 3's headline aid), then rung-2 aids.
    expect(r3.options).toEqual(["srcsteps=10", "gminsteps=1", "itl1=500"]);
    expect(r3.relaxes).toBe(false);
  });

  it("rung 4 is Gear + relaxed reltol and marks itself relaxes:true", () => {
    const r4 = CONVERGENCE_LADDER[3]!;
    expect(r4.name).toBe("Gear + relaxed reltol");
    expect(r4.options).toEqual([
      "method=gear",
      "reltol=0.005",
      "srcsteps=10",
      "gminsteps=1",
      "itl1=500",
      "itl4=100",
    ]);
    expect(r4.relaxes).toBe(true);
  });
});

describe("buildRungNetlist", () => {
  // Corpus-shaped deck: title comment on line 0 + devices + analysis. Every
  // real deck (compileSpice output + hand-written ones in the /sim-lab) has
  // a title on line 0 — SPICE ignores the first line by convention.
  const BASE = "* Title comment\nV1 in 0 DC 5\nR1 in mid 10k\n.tran 1u 5m\n.end\n";

  it("rung 1 = prepareNetlist(base) unchanged (no options injected)", () => {
    const r1 = CONVERGENCE_LADDER[0]!;
    const out = buildRungNetlist(BASE, r1);
    expect(out).toBe(prepareNetlist(BASE));
    // No injected .options line anywhere.
    expect(out).not.toMatch(/^\.options gminsteps/m);
  });

  it("rung 2 injects `.options gminsteps=1 itl1=500` AFTER the title line", () => {
    // The SPICE title-line rule: line 0 is ignored, so the injected .options
    // MUST go on line 1 to actually take effect. See ladder.ts for why this
    // is not a plain prepend (it was the port bug in the first cut).
    const r2 = CONVERGENCE_LADDER[1]!;
    const out = buildRungNetlist(BASE, r2);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\*/); // title survives at line 0
    expect(lines[1]).toBe(".options gminsteps=1 itl1=500");
    // The base circuit + analysis lines still ride below the injected .options.
    expect(out).toMatch(/V1 in 0 DC 5/);
    expect(out).toMatch(/\.tran 1u 5m/);
  });

  it("rung 4 injects the Gear + relaxed reltol option line after the title", () => {
    const r4 = CONVERGENCE_LADDER[3]!;
    const out = buildRungNetlist(BASE, r4);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^\*/);
    expect(lines[1]).toBe(
      ".options method=gear reltol=0.005 srcsteps=10 gminsteps=1 itl1=500 itl4=100",
    );
  });

  it("preserves a `.control` block strip from prepareNetlist (transport still applies)", () => {
    const withControl =
      "* deck\nV1 a 0 1\n.control\nrun\nwrdata ../x.csv v(a)\n.endc\n.tran 1u 5m\n.end\n";
    const r2 = CONVERGENCE_LADDER[1]!;
    const out = buildRungNetlist(withControl, r2);
    expect(out).not.toMatch(/\.control/i);
    expect(out).not.toMatch(/wrdata/i);
    // Injection sits after the title, not before it (which would be a comment).
    const lines = out.split("\n");
    expect(lines[0]).toBe("* deck");
    expect(lines[1]).toBe(".options gminsteps=1 itl1=500");
  });
});

describe("runConvergenceLadder", () => {
  const BASE = "* title\nV1 in 0 DC 5\nR1 in mid 10k\n.tran 1u 5m\n.end\n";

  it("stops at rung 1 when it converges (no further rungs attempted)", async () => {
    const seenRungs: number[] = [];
    const runOne = async (
      _netlist: string,
      rung: LadderRung,
    ): Promise<RungOutcome<string>> => {
      seenRungs.push(rung.rung);
      return { converged: true, result: `rung-${rung.rung}` };
    };
    const outcome = await runConvergenceLadder(BASE, runOne);
    expect(seenRungs).toEqual([1]);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.converged).toBe(true);
    expect(outcome.winningRung?.rung).toBe(1);
    expect(outcome.result).toBe("rung-1");
  });

  it("climbs rungs 2 -> 3 -> ... until one converges", async () => {
    const seenRungs: number[] = [];
    const runOne = async (
      _netlist: string,
      rung: LadderRung,
    ): Promise<RungOutcome<string>> => {
      seenRungs.push(rung.rung);
      // Fail rung 1 and 2; converge on rung 3.
      return { converged: rung.rung >= 3, result: `rung-${rung.rung}` };
    };
    const outcome = await runConvergenceLadder(BASE, runOne);
    expect(seenRungs).toEqual([1, 2, 3]);
    expect(outcome.attempts.map((a) => a.converged)).toEqual([false, false, true]);
    expect(outcome.winningRung?.rung).toBe(3);
    expect(outcome.result).toBe("rung-3");
    // Options were carried through into the attempt record.
    expect(outcome.attempts[1]!.options).toEqual(["gminsteps=1", "itl1=500"]);
  });

  it("walks all 4 rungs on terminal exhaustion and reports winningRung: null", async () => {
    const seenRungs: number[] = [];
    const runOne = async (
      _netlist: string,
      rung: LadderRung,
    ): Promise<RungOutcome<string>> => {
      seenRungs.push(rung.rung);
      return { converged: false, result: `failed-rung-${rung.rung}` };
    };
    const outcome = await runConvergenceLadder(BASE, runOne);
    expect(seenRungs).toEqual([1, 2, 3, 4]);
    expect(outcome.attempts.every((a) => !a.converged)).toBe(true);
    expect(outcome.winningRung).toBeNull();
    // On terminal, the LAST rung's result is preserved so callers can still
    // surface whatever the last attempt produced (e.g. an error diagnostic).
    expect(outcome.result).toBe("failed-rung-4");
  });

  it("hands each rung the correct netlist (rung's .options prefix)", async () => {
    const seen: { rung: number; netlist: string }[] = [];
    const runOne = async (
      netlist: string,
      rung: LadderRung,
    ): Promise<RungOutcome<null>> => {
      seen.push({ rung: rung.rung, netlist });
      return { converged: rung.rung === 4, result: null };
    };
    await runConvergenceLadder(BASE, runOne);
    // Rung 1: no .options prefix (as-written).
    expect(seen[0]!.netlist).toBe(prepareNetlist(BASE));
    // Rung 4: title on line 0, injected .options on line 1 (not before the
    // title — the title-line rule).
    const rung4Lines = seen[3]!.netlist.split("\n");
    expect(rung4Lines[0]).toBe("* title");
    expect(rung4Lines[1]).toBe(
      ".options method=gear reltol=0.005 srcsteps=10 gminsteps=1 itl1=500 itl4=100",
    );
  });
});
