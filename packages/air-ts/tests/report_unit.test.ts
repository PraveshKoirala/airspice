/**
 * Report pipeline unit tests (issue #14) — the parity traps in isolation.
 *
 * These pin the non-obvious behaviors an adversarial verifier re-derives with
 * its OWN waveforms: measurement_stats min/max tie-breaking + time selection,
 * the flat-DC-stat shape, assertion codes/observed payloads, the honest
 * as-written convergence section, and the CSV export FORMAT. Numbers here are
 * synthetic (not corpus values) so nothing keys off a fixture (guardrails R4).
 */

import { describe, expect, it } from "vitest";
import {
  statsForSamples,
  statsFromMeasurements,
  serializeStats,
  evaluateAssertions,
  convergenceSection,
  waveformCsv,
  measureDc,
  probeNets,
  buildReport,
  type Sample,
  type SignalStats,
} from "../src/sim/report.js";
import type { SystemIR, Test } from "../src/model.js";
import { parse } from "../src/index.js";

describe("measurement_stats: min/max tie-breaking + time selection (the #14 parity trap)", () => {
  it("final is the LAST sample; min/max are the extrema; times are the extremum times", () => {
    const samples: Sample[] = [
      [0.0, 1.0],
      [1e-3, 3.0],
      [2e-3, -2.0],
      [3e-3, 0.5],
    ];
    const s = statsForSamples(samples, "V");
    expect(s.final).toBe(0.5);
    expect(s.min).toBe(-2.0);
    expect(s.max).toBe(3.0);
    expect(s.timeOfMin).toBe(2e-3);
    expect(s.timeOfMax).toBe(1e-3);
  });

  it("ties resolve to the FIRST occurrence (Python min()/max() semantics)", () => {
    // Two samples share the minimum (-1) and two share the maximum (5). Python's
    // `min(..., key=value)` / `max(...)` return the FIRST; a strict </> scan must
    // match that — NOT the last.
    const samples: Sample[] = [
      [0.0, 2.0],
      [1.0, 5.0], // first max
      [2.0, -1.0], // first min
      [3.0, 5.0], // second max (must NOT win)
      [4.0, -1.0], // second min (must NOT win)
      [5.0, 3.0],
    ];
    const s = statsForSamples(samples, "V");
    expect(s.timeOfMax).toBe(1.0);
    expect(s.timeOfMin).toBe(2.0);
    expect(s.final).toBe(3.0);
  });

  it("a flat waveform has min=max=final and time_of_min=time_of_max=first-sample time", () => {
    const samples: Sample[] = [
      [0.0, 2.5],
      [1e-3, 2.5],
      [5e-3, 2.5],
    ];
    const s = statsForSamples(samples, "V");
    expect(s.min).toBe(2.5);
    expect(s.max).toBe(2.5);
    expect(s.final).toBe(2.5);
    expect(s.timeOfMin).toBe(0.0);
    expect(s.timeOfMax).toBe(0.0);
    // Serialized: "0s" for the times (formatG(0,9) -> "0"), "2.5V" for the rest.
    const ser = serializeStats(new Map([["mid", s]]));
    expect(ser["mid"]).toEqual({
      final: "2.5V",
      min: "2.5V",
      max: "2.5V",
      time_of_min: "0s",
      time_of_max: "0s",
    });
  });
});

describe("statsFromMeasurements: DC measurements become flat stats at t=0", () => {
  it("each measurement -> final=min=max=value, times 0, unit by name", () => {
    const stats = statsFromMeasurements(
      new Map([
        ["vin", 5.0],
        ["i(LOAD_A)", 0.01],
      ]),
    );
    const v = stats.get("vin") as SignalStats;
    expect(v).toEqual({ final: 5, min: 5, max: 5, timeOfMin: 0, timeOfMax: 0, unit: "V" });
    const i = stats.get("i(LOAD_A)") as SignalStats;
    expect(i.unit).toBe("A");
    const ser = serializeStats(stats);
    expect(ser["i(LOAD_A)"]!.final).toBe("10mA");
    expect(ser["vin"]!.final).toBe("5V");
  });
});

describe("serializeStats: %.9g time rendering with an 's' suffix", () => {
  it("time_of_min/max use 9 significant figures + 's'", () => {
    const s: SignalStats = {
      final: 1.0,
      min: 1.0,
      max: 1.0,
      timeOfMin: 0.00123456789,
      timeOfMax: 0.005,
      unit: "V",
    };
    const ser = serializeStats(new Map([["x", s]]));
    expect(ser["x"]!.time_of_min).toBe("0.00123456789s");
    expect(ser["x"]!.time_of_max).toBe("0.005s");
  });
});

describe("evaluateAssertions: codes + observed payloads (repair-context contract)", () => {
  function mkTest(assertions: Array<Record<string, string>>): Test {
    return {
      id: "t",
      description: "",
      setup: new Map(),
      duration: "1ms",
      assertions,
      analysis: null,
    };
  }

  it("in-range assertion produces NO diagnostic", () => {
    const test = mkTest([{ op: "assert_voltage", net: "mid", min: "2.45V", max: "2.55V" }]);
    const measured = new Map([["mid", 2.5]]);
    const stats = statsFromMeasurements(measured);
    expect(evaluateAssertions(test, measured, stats)).toEqual([]);
  });

  it("out-of-range voltage -> ASSERT_FAILED with observed min/max/final + times", () => {
    const test = mkTest([{ op: "assert_voltage", net: "mid", min: "2.45V", max: "2.55V" }]);
    const measured = new Map([["mid", 2.5]]);
    // A waveform that dips below the min gives observedMin < min -> fail.
    const stats = new Map<string, SignalStats>([
      ["mid", { final: 2.5, min: 2.0, max: 2.5, timeOfMin: 3e-3, timeOfMax: 0, unit: "V" }],
    ]);
    const diags = evaluateAssertions(test, measured, stats);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.code).toBe("ASSERT_FAILED");
    expect(d.severity).toBe("error");
    expect(d.id).toBe("diag_00001");
    expect(d.related_elements).toEqual(["t", "mid"]);
    expect(d.observed).toMatchObject({
      final: "2.5V",
      min: "2V",
      max: "2.5V",
      time_of_min: "0.003s",
      time_of_max: "0s",
    });
    expect(d.expected).toEqual({ min: "2.45V", max: "2.55V" });
  });

  it("missing measurement -> ASSERT_NO_MEASUREMENT", () => {
    const test = mkTest([{ op: "assert_voltage", net: "absent", min: "0V", max: "1V" }]);
    const diags = evaluateAssertions(test, new Map(), new Map());
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("ASSERT_NO_MEASUREMENT");
  });

  it("assert_current subject is i(<component>)", () => {
    const test = mkTest([{ op: "assert_current", component: "LOAD_A", max: "5mA" }]);
    const measured = new Map([["i(LOAD_A)", 0.01]]); // 10mA > 5mA -> fail
    const stats = statsFromMeasurements(measured);
    const diags = evaluateAssertions(test, measured, stats);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.related_elements).toEqual(["t", "i(LOAD_A)"]);
    expect(diags[0]!.observed.max).toBe("10mA");
  });
});

describe("convergence section: honest as-written (browser has no #45 ladder)", () => {
  it("engine ran + converged -> the corpus rung-1 section (aids_required:false)", () => {
    expect(convergenceSection(true, true)).toEqual({
      attempts: [{ rung: 1, name: "as-written", options: [], converged: true }],
      converged: true,
      rung: 1,
      aids_required: false,
      terminal: false,
      note: null,
    });
  });

  it("engine ran + did NOT converge -> honest terminal (NO fabricated ladder)", () => {
    const c = convergenceSection(true, false);
    expect(c.converged).toBe(false);
    expect(c.terminal).toBe(true);
    expect(c.rung).toBeNull();
    expect(c.aids_required).toBe(false);
    // Only ONE rung-1 attempt — the browser never climbed a ladder it can't run.
    expect(c.attempts).toEqual([
      { rung: 1, name: "as-written", options: [], converged: false },
    ]);
    expect(c.note).toContain("topology");
  });

  it("engine unavailable -> single not-converged rung-1 attempt flagged ngspice_missing", () => {
    const c = convergenceSection(false, false);
    expect(c.attempts).toEqual([
      { rung: 1, name: "as-written", options: [], converged: false, ngspice_missing: true },
    ]);
    expect(c.note).toBeNull();
    expect(c.terminal).toBe(false);
  });
});

describe("waveformCsv: FORMAT parity with the oracle's canonical CSV", () => {
  it("header, comma columns, CPython float repr, LF endings, trailing newline", () => {
    const csv = waveformCsv("mid", [
      [0.0, 2.5],
      [3.28e-6, 2.5],
      [0.0010007, 2.5],
      [0.005, 2.5],
    ]);
    expect(csv).toBe("time_s,v(mid)\n0.0,2.5\n3.28e-06,2.5\n0.0010007,2.5\n0.005,2.5\n");
    expect(csv.includes("\r")).toBe(false);
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("ground nets render as v(0) in the header (spice_net normalization)", () => {
    expect(waveformCsv("gnd", [[0, 0]]).startsWith("time_s,v(0)\n")).toBe(true);
    expect(waveformCsv("0", [[0, 0]]).startsWith("time_s,v(0)\n")).toBe(true);
  });

  it("downsamples by the Python samples[::step] stride and always keeps the final sample", () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 1201; i++) samples.push([i * 1e-6, i]);
    const csv = waveformCsv("s", samples, 500);
    const rows = csv.split("\n").filter((l) => l.length > 0);
    // step = floor(1201/500) = 2 -> ceil(1201/2)=601 strided + final already
    // present (1200 is even index) => 601 rows.
    expect(rows.length - 1).toBe(601);
    // The true final sample (t=1200us, v=1200) must be the last data row.
    expect(rows[rows.length - 1]).toBe("0.0012,1200.0");
  });
});

describe("measureDc: the analytic DC pass (browser has no backend)", () => {
  const DIVIDER = `<system name="d" ir_version="0.1">
    <nets>
      <net id="gnd" role="ground"/>
      <net id="vin" role="power"/>
      <net id="mid" role="analog_signal"/>
    </nets>
    <components>
      <component id="V1" type="voltage_source"><value>5V</value>
        <pin name="p" net="vin"/><pin name="n" net="gnd"/></component>
      <component id="R1" type="resistor"><value>10k</value>
        <pin name="1" net="vin"/><pin name="2" net="mid"/></component>
      <component id="R2" type="resistor"><value>10k</value>
        <pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
    </components>
    <tests><test id="t"><run duration="5ms"/>
      <assert_voltage net="mid" min="2.4V" max="2.6V"/></test></tests>
    <simulation_profiles><profile id="p" default="true">
      <backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
  </system>`;

  it("solves a resistive divider to its midpoint voltage", () => {
    const ir: SystemIR = parse(DIVIDER);
    const test = ir.tests.get("t")!;
    const m = measureDc(ir, test);
    expect(m.get("vin")).toBeCloseTo(5, 9);
    expect(m.get("gnd")).toBe(0);
    expect(m.get("mid")).toBeCloseTo(2.5, 9);
  });

  it("probeNets = assert_voltage nets ∪ subsystem probes, sorted", () => {
    const ir: SystemIR = parse(DIVIDER);
    const test = ir.tests.get("t")!;
    expect(probeNets(ir, test, "p")).toEqual(["mid"]);
  });
});

describe("buildReport: probed net value comes from the waveform final, not the DC pass", () => {
  const XML = `<system name="d" ir_version="0.1">
    <nets>
      <net id="gnd" role="ground"/>
      <net id="vin" role="power"/>
      <net id="mid" role="analog_signal"/>
    </nets>
    <components>
      <component id="V1" type="voltage_source"><value>5V</value>
        <pin name="p" net="vin"/><pin name="n" net="gnd"/></component>
      <component id="R1" type="resistor"><value>10k</value>
        <pin name="1" net="vin"/><pin name="2" net="mid"/></component>
      <component id="R2" type="resistor"><value>10k</value>
        <pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
    </components>
    <tests><test id="t"><run duration="5ms"/>
      <assert_voltage net="mid" min="2.4V" max="2.6V"/></test></tests>
    <simulation_profiles><profile id="p" default="true">
      <backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
  </system>`;

  it("overwrites the DC-solved probed net with the transient final sample", () => {
    const ir = parse(XML);
    const test = ir.tests.get("t")!;
    // Engine says mid settled to 2.51 (slightly off the 2.5 DC solve).
    const tables = [
      { name: "time", values: new Float64Array([0, 1e-3, 5e-3]) },
      { name: "v(mid)", values: new Float64Array([2.5, 2.505, 2.51]) },
    ];
    const report = buildReport({ ir, test, profileId: "p", waveTables: tables, engineAttempted: true });
    expect(report.backend).toBe("ngspice");
    expect(report.status).toBe("passed");
    // measurements.mid is the waveform FINAL (2.51), not the DC 2.5.
    expect(report.measurements.mid).toBe("2.51V");
    // vin/gnd stay DC.
    expect(report.measurements.vin).toBe("5V");
    expect(report.measurements.gnd).toBe("0V");
    expect(report.convergence).toMatchObject({ converged: true, rung: 1, aids_required: false });
  });

  it("engine unavailable -> builtin_dc_fallback + ngspice_missing, probed net keeps DC value", () => {
    const ir = parse(XML);
    const test = ir.tests.get("t")!;
    const report = buildReport({ ir, test, profileId: "p", waveTables: [], engineAttempted: false });
    expect(report.backend).toBe("builtin_dc_fallback");
    expect(report.measurements.mid).toBe("2.5V");
    expect(report.convergence.attempts[0]!.ngspice_missing).toBe(true);
    expect(report.convergence.terminal).toBe(false);
  });

  it("engine attempted but produced NO data -> honest terminal (disclosed non-convergence)", () => {
    // This is the eecircuit-singular-matrix case: the engine ran as-written and
    // did not converge. The honest report is terminal, NOT ngspice_missing, and
    // measurements fall back to the analytic DC pass.
    const ir = parse(XML);
    const test = ir.tests.get("t")!;
    const report = buildReport({ ir, test, profileId: "p", waveTables: [], engineAttempted: true });
    expect(report.backend).toBe("builtin_dc_fallback");
    expect(report.convergence.terminal).toBe(true);
    expect(report.convergence.converged).toBe(false);
    expect(report.convergence.rung).toBeNull();
    // NOT flagged ngspice_missing — the engine WAS available.
    expect(report.convergence.attempts[0]!.ngspice_missing).toBeUndefined();
    expect(report.measurements.mid).toBe("2.5V");
  });
});
