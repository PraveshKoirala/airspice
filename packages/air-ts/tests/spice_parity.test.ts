/**
 * SPICE netlist parity suite (issue #9).
 *
 * Byte-diffs the air-ts emitter against the golden corpus for EVERY design that
 * has a `netlist.cir` and/or `report/probes.json` fixture, and proves the
 * refusal gate for every design that has neither (the failing/invalid designs,
 * whose absent netlist is itself the expected output).
 *
 * The corpus is the contract (AGENTS.md rule 3): fixtures are read-only here and
 * never regenerated to match this port. Design discovery is dynamic (harness
 * readdir) -- no corpus name is hard-coded, so adding a design extends the suite.
 *
 * A dynamic count assertion pins WHAT the corpus actually contains today (5
 * netlists, 4 probes) so a fixture appearing/disappearing can never silently
 * shrink the parity surface.
 */

import { describe, expect, it } from "vitest";
import { compileDesign } from "../src/emit/spice.js";
import { byteDiff, discoverDesigns, readText } from "./harness.js";

const designs = discoverDesigns();
const withNetlist = designs.filter((d) => d.hasNetlist);
const withProbes = designs.filter((d) => d.hasProbes);
const withoutNetlist = designs.filter((d) => !d.hasNetlist);

describe("SPICE parity: netlist.cir byte-diff", () => {
  it("the corpus exposes at least one compiled netlist (guard against an empty suite)", () => {
    expect(withNetlist.length).toBeGreaterThan(0);
  });

  for (const design of withNetlist) {
    it(`${design.name}: main.cir is byte-identical to netlist.cir`, () => {
      const artifacts = compileDesign(readText(design.inputPath));
      // A design with a netlist fixture is valid, so the gate must NOT refuse.
      expect(artifacts, `${design.name}: expected a compiled netlist, got refusal`).not.toBeNull();
      const expected = readText(design.netlistPath);
      const diff = byteDiff(artifacts!.netlist, expected, `${design.name}/netlist.cir`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

describe("SPICE parity: report/probes.json byte-diff", () => {
  it("the corpus exposes at least one probes descriptor (guard against an empty suite)", () => {
    expect(withProbes.length).toBeGreaterThan(0);
  });

  for (const design of withProbes) {
    it(`${design.name}: probes.json is byte-identical to report/probes.json`, () => {
      const artifacts = compileDesign(readText(design.inputPath));
      expect(artifacts, `${design.name}: expected a compiled design, got refusal`).not.toBeNull();
      const expected = readText(design.probesPath);
      const diff = byteDiff(artifacts!.probes, expected, `${design.name}/probes.json`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

describe("SPICE refusal gate: error-severity designs emit NO netlist", () => {
  it("the corpus exposes at least one refused design (the failing/invalid set)", () => {
    expect(withoutNetlist.length).toBeGreaterThan(0);
  });

  for (const design of withoutNetlist) {
    it(`${design.name}: compileDesign refuses (returns null, no fixture to match)`, () => {
      const artifacts = compileDesign(readText(design.inputPath));
      expect(
        artifacts,
        `${design.name}: has no netlist.cir fixture, so the emitter must refuse it`,
      ).toBeNull();
    });
  }
});

describe("SPICE parity: corpus inventory is pinned (fixtures cannot silently vanish)", () => {
  // These counts reflect the committed corpus at issue #9 time: the 5 valid
  // designs the oracle compiled (analog_primitives, complex_bms,
  // esp32_battery_sensor, mixed_signal_switch, stm32_demo) and the 4 of those
  // whose default profile carries an ngspice backend (all but stm32_demo).
  // They are asserted dynamically -- not by name -- so this stays a tripwire,
  // not a hard-coded fixture list (guardrails R4). If the corpus legitimately
  // grows via an oracle change, bump these numbers in the same oracle-first PR.
  it("exactly 5 designs have a netlist and 4 have a probes descriptor", () => {
    expect(withNetlist.length).toBe(5);
    expect(withProbes.length).toBe(4);
  });

  it("every design is either compiled or refused -- no design is unaccounted for", () => {
    expect(withNetlist.length + withoutNetlist.length).toBe(designs.length);
  });
});

describe("SPICE parity: mutation self-test (the byte-diff has teeth)", () => {
  it("a one-byte perturbation of a compiled netlist is detected", () => {
    const design = withNetlist[0]!;
    const artifacts = compileDesign(readText(design.inputPath));
    expect(artifacts).not.toBeNull();
    const good = artifacts!.netlist;
    // Flip one character in the middle (guaranteed a real content change).
    const idx = Math.floor(good.length / 2);
    const mutated = good.slice(0, idx) + (good[idx] === "X" ? "Y" : "X") + good.slice(idx + 1);
    const expected = readText(design.netlistPath);
    const cleanDiff = byteDiff(good, expected, "self-test/clean");
    const dirtyDiff = byteDiff(mutated, expected, "self-test/mutated");
    expect(cleanDiff.equal, "clean netlist must match the fixture").toBe(true);
    expect(dirtyDiff.equal, "mutated netlist must NOT match the fixture").toBe(false);
    expect(dirtyDiff.firstDiffIndex).toBe(idx);
  });

  it("byteDiff is a strict === identity check (no whitespace/float normalization)", () => {
    // Trailing-newline and whitespace differences must be caught: a netlist that
    // drops the trailing newline is a real byte difference, not a harmless one.
    expect(byteDiff("a\n", "a", "nl").equal).toBe(false);
    expect(byteDiff("R1 a b 10k", "R1 a b 10k ", "ws").equal).toBe(false);
    expect(byteDiff("4.999ms", "4.999m", "unit").equal).toBe(false);
    expect(byteDiff("same", "same", "id").equal).toBe(true);
  });
});
