/**
 * SPICE differential-probe suite (issue #9): air-ts vs the LIVE Python oracle on
 * designs BEYOND the golden corpus.
 *
 * These eight designs are ours (not corpus fixtures), chosen to stress exactly
 * the places byte parity is fragile:
 *   - numeric net names (`1`/`2`/`10`) -- the #79 lesson: a Map preserves
 *     document order and lexicographic probe sort (`10` before `2`), where a
 *     plain object would reorder integer-like keys;
 *   - multiple probes on one test;
 *   - each simulation-profile shape (ngspice-only default, ngspice+renode,
 *     renode-only) -- the oracle's `compile_spice` always emits `.tran`, so the
 *     profile shape is the varied dimension, not the analysis directive;
 *   - mixed passives + BJT + MOSFET + diode using the builtin models, both with
 *     an explicit `spice_model` and with the default fallback (NPN/NMOS/D);
 *   - the LDO behavioural source, generic_load DC + load-step PULSE, current
 *     source, firmware PWM stimulus, the test-source/component-source collision
 *     skip, and the `M`->`Meg` rewrite;
 *   - rework round 1 regressions: the Python `or`-chain's empty-string
 *     fallthrough on the generic_load current (d7 -- `??` would silently drop
 *     both device lines) and the `list.index(op)` content-equality quirk (d8 --
 *     two identical write_gpio ops both take the FIRST op's delay as ton).
 *
 * The `.expected.cir` reference beside each design is the ORACLE'S output,
 * produced by `scripts/gen-spice-diff-refs.py` (which calls
 * `air.spice.compile_spice` with the first test, exactly like the golden
 * exporter). This test byte-diffs the air-ts netlist against it. If the oracle
 * changes, regenerate the references with that script -- never hand-edit them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileDesign } from "../src/emit/spice.js";
import { byteDiff } from "./harness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESIGN_DIR = join(HERE, "spice_diff_designs");

interface DiffCase {
  name: string;
  xmlPath: string;
  refPath: string;
}

function discoverDiffCases(): DiffCase[] {
  const cases: DiffCase[] = [];
  for (const entry of readdirSync(DESIGN_DIR)) {
    if (!entry.endsWith(".air.xml")) continue;
    const base = entry.slice(0, -".air.xml".length);
    cases.push({
      name: base,
      xmlPath: join(DESIGN_DIR, entry),
      refPath: join(DESIGN_DIR, `${base}.expected.cir`),
    });
  }
  cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return cases;
}

const cases = discoverDiffCases();

describe("SPICE differential probes vs the live oracle", () => {
  it("all eight differential designs are present", () => {
    expect(cases.length).toBe(8);
  });

  for (const c of cases) {
    it(`${c.name}: air-ts netlist is byte-identical to the oracle reference`, () => {
      const xml = readFileSync(c.xmlPath, "utf-8");
      const expected = readFileSync(c.refPath, "utf-8");
      const artifacts = compileDesign(xml);
      expect(artifacts, `${c.name}: expected a compiled netlist (design must be valid)`).not.toBeNull();
      const diff = byteDiff(artifacts!.netlist, expected, `${c.name}.expected.cir`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }

  it("numeric-net probe order is lexicographic (`10` sorts before `2`) -- the #79 stress", () => {
    // Guard the exact ordering that a plain-object collection would get wrong.
    const d1 = cases.find((c) => c.name.startsWith("d1"));
    expect(d1).toBeDefined();
    const netlist = compileDesign(readFileSync(d1!.xmlPath, "utf-8"))!.netlist;
    const probeLines = netlist.split("\n").filter((l) => l.startsWith("wrdata"));
    expect(probeLines).toEqual([
      "wrdata ../waveforms/divider_probe_10.csv v(10)",
      "wrdata ../waveforms/divider_probe_2.csv v(2)",
    ]);
  });

  it("or-chain fallthrough: empty set_current and empty current property still emit device lines (rework r1, divergence 1)", () => {
    // Pre-fix `??` stopped at the empty string and BOTH loads vanished from the
    // netlist. Oracle bytes: the empty <set_current> falls through to the
    // `current` property (LOADA -> 10mA); the empty property falls through to
    // <value> (LOADB -> 5mA).
    const d7 = cases.find((c) => c.name.startsWith("d7"));
    expect(d7).toBeDefined();
    const netlist = compileDesign(readFileSync(d7!.xmlPath, "utf-8"))!.netlist;
    const loadLines = netlist.split("\n").filter((l) => l.startsWith("I_LOAD"));
    expect(loadLines).toEqual(["I_LOADA v33 0 DC 10mA", "I_LOADB v33 0 DC 5mA"]);
  });

  it("list.index quirk: two content-identical write_gpio ops BOTH take the first op's delay (rework r1, divergence 2)", () => {
    // Oracle: `task.operations.index(op)` matches the FIRST content-equal op,
    // so the second identical write_gpio also anchors its delay search after
    // the first -> both PULSE cards use ton=1ms (PW 999us), not 3ms (2.999ms).
    const d8 = cases.find((c) => c.name.startsWith("d8"));
    expect(d8).toBeDefined();
    const netlist = compileDesign(readFileSync(d8!.xmlPath, "utf-8"))!.netlist;
    const stimLines = netlist.split("\n").filter((l) => l.startsWith("V_STIM_"));
    expect(stimLines).toEqual([
      "V_STIM_U_MCU_GPIO0 sig 0 PULSE(0 3.3 0 1us 1us 999us 10ms)",
      "V_STIM_U_MCU_GPIO0 sig 0 PULSE(0 3.3 0 1us 1us 999us 10ms)",
    ]);
  });
});
