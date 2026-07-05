/**
 * Report-schema parity suite (issue #14).
 *
 * Proves `buildReport` (packages/air-ts/src/sim/report.ts) reproduces the Python
 * oracle's `simulator.py` report EXACTLY — byte-for-byte, including numeric
 * fields — when it is fed the corpus's OWN committed waveform CSVs as the engine
 * output. This isolates the report LOGIC (the DC solver, measurement_stats
 * tie-breaking, the convergence section, assertion evaluation, the sorted-key
 * JSON) from engine numeric noise: with the same samples the oracle used, the
 * report string must match `report/reports/<test>.json` to the byte.
 *
 * The complementary numeric-tolerance parity against the REAL browser engine
 * (eecircuit ngspice 45.2 vs native 42) is the Playwright test in packages/ui;
 * that one runs the FULL browser pipeline. This vitest suite is the pure-logic
 * proof (no browser, no WASM), and it is the stronger one for the report SCHEMA:
 * it demands byte-exactness, not tolerance.
 *
 * The corpus is the contract (AGENTS.md rule 3): fixtures are read-only here and
 * never regenerated to match this port. Design discovery is dynamic — no corpus
 * name is hard-coded (guardrails R4).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/index.js";
import {
  buildReport,
  serializeReportJson,
  defaultNgspiceProfile,
  type WaveTableLike,
} from "../src/sim/report.js";
import { discoverDesigns, byteDiff, readText } from "./harness.js";

/** Parse a canonical `time_s,v(net)` waveform CSV into aligned arrays. */
function parseWaveformCsv(text: string): { time: number[]; value: number[] } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const time: number[] = [];
  const value: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(",");
    time.push(parseFloat(parts[0]!));
    value.push(parseFloat(parts[1]!));
  }
  return { time, value };
}

/**
 * Build the engine-output WaveTables for one test from the corpus's committed
 * waveform CSVs — i.e. replay the oracle's own samples through the browser report
 * builder. Returns null when the design has no report dir.
 */
function corpusWaveTables(
  designDir: string,
  testId: string,
): { tables: WaveTableLike[]; engineAttempted: boolean } | null {
  const waveDir = join(designDir, "report", "waveforms");
  if (!existsSync(waveDir)) return null;
  const prefix = `${testId}_`;
  const files = readdirSync(waveDir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".csv"),
  );
  const tables: WaveTableLike[] = [];
  let timeArr: number[] | null = null;
  for (const f of files) {
    const net = f.slice(prefix.length, f.length - ".csv".length);
    const { time, value } = parseWaveformCsv(readFileSync(join(waveDir, f), "utf-8"));
    if (!timeArr) timeArr = time;
    tables.push({ name: `v(${net})`, values: new Float64Array(value) });
  }
  if (timeArr) tables.push({ name: "time", values: new Float64Array(timeArr) });
  return { tables, engineAttempted: files.length > 0 };
}

interface ReportCase {
  design: string;
  testId: string;
  reportPath: string;
}

/** Every (design, test) that has a committed report JSON in the corpus. */
function discoverReportCases(): ReportCase[] {
  const cases: ReportCase[] = [];
  for (const design of discoverDesigns()) {
    const reportsDir = join(design.dir, "report", "reports");
    if (!existsSync(reportsDir)) continue;
    for (const f of readdirSync(reportsDir)) {
      if (!f.endsWith(".json")) continue;
      cases.push({
        design: design.name,
        testId: f.slice(0, f.length - ".json".length),
        reportPath: join(reportsDir, f),
      });
    }
  }
  cases.sort((a, b) =>
    `${a.design}/${a.testId}` < `${b.design}/${b.testId}` ? -1 : 1,
  );
  return cases;
}

const designsByName = new Map(discoverDesigns().map((d) => [d.name, d]));
const reportCases = discoverReportCases();

describe("report parity: browser buildReport reproduces the oracle report byte-for-byte", () => {
  it("the corpus exposes at least one report JSON (guard against an empty suite)", () => {
    expect(reportCases.length).toBeGreaterThan(0);
  });

  for (const rc of reportCases) {
    it(`${rc.design}/${rc.testId}: report JSON is byte-identical to the oracle`, () => {
      const design = designsByName.get(rc.design)!;
      const ir = parse(readText(design.inputPath));
      const profileId = defaultNgspiceProfile(ir);
      expect(profileId, `${rc.design}: expected an ngspice profile`).not.toBeNull();
      const test = ir.tests.get(rc.testId);
      expect(test, `${rc.design}: missing test ${rc.testId}`).toBeDefined();

      const wt = corpusWaveTables(design.dir, rc.testId);
      expect(wt, `${rc.design}: expected waveform fixtures`).not.toBeNull();

      const report = buildReport({
        ir,
        test: test!,
        profileId: profileId!,
        waveTables: wt!.tables,
        engineAttempted: wt!.engineAttempted,
      });
      const actual = serializeReportJson(report);
      const expected = readText(rc.reportPath).replace(/\r\n/g, "\n");
      const diff = byteDiff(actual, expected, `${rc.design}/${rc.testId}.json`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

describe("report parity: the corpus report set is pinned (fixtures cannot silently vanish)", () => {
  // Reflects the committed corpus at issue #14 time: 5 report JSONs across 4
  // designs (esp32_battery_sensor has two tests). Asserted dynamically off the
  // discovery so no corpus name is hard-coded (guardrails R4); bump in an
  // oracle-first PR if the corpus legitimately grows.
  it("exactly 5 report cases are present", () => {
    expect(reportCases.length).toBe(5);
  });
});
