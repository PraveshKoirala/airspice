/**
 * Report-schema parity in a REAL browser (issue #14 deliverable 6 — the M2 proof).
 *
 * For each corpus design that has a committed report, this drives the FULL local
 * browser pipeline (compile air-ts #9 -> WASM ngspice worker sim-wasm #13 ->
 * report air-ts report.ts #14 -> typed-array retention), with NO backend, in a
 * real Chromium, and checks the browser's report JSON against the corpus
 * `report/reports/<test>.json`:
 *
 *   - STRUCTURE byte-exact: JSON keys + ordering, the convergence section, the
 *     backend label, the measurement_stats key set — everything that is not a
 *     number must match to the byte (the exporter's `_compare_numeric_text`
 *     contract, reproduced in corpus.ts `compareReport`).
 *   - NUMERIC fields within rtol 1e-3: the browser engine is eecircuit ngspice
 *     45.2, the corpus is native 42, so the last digits drift; 1e-3 is the #14
 *     report-parity tolerance (#15 owns cross-engine waveform tolerance).
 *   - `time_of_min`/`time_of_max` are compared with an ABSOLUTE time tolerance:
 *     the extremum-time of a numerically-flat signal is engine-arbitrary (see
 *     corpus.ts). The extremum VALUE still matches within rtol.
 *
 * DISCLOSED DIVERGENCE (honest, not papered over): a design that native ngspice
 * 42 converges but eecircuit 45.2 cannot solve AS-WRITTEN (e.g. an operating
 * point eecircuit reports as a singular matrix) is reported by the browser as an
 * HONEST `terminal` non-convergence — the browser has no #45 ladder to climb.
 * Such a design is asserted to be honestly terminal, NOT forced to fake parity.
 * A tripwire pins how many designs converge vs. honestly diverge, so a
 * regression that turns a CONVERGING design terminal (a real bug) fails here.
 *
 * Numbers are read from the committed fixtures, never hand-copied (AGENTS.md rule
 * 3); no corpus design name is hard-coded (guardrails R4).
 */

import { test, expect } from "@playwright/test";
import { loadReportCases, compareReport } from "./corpus";

const RTOL = 1e-3;
const CASES = loadReportCases();

// Group cases by design so each design runs its full profile once.
const byDesign = new Map<string, typeof CASES>();
for (const c of CASES) {
  const list = byDesign.get(c.design) ?? [];
  list.push(c);
  byDesign.set(c.design, list);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __air?: unknown }).__air !== undefined);
});

test("the corpus exposes at least one report case (guard against an empty suite)", () => {
  expect(CASES.length).toBeGreaterThan(0);
});

for (const [design, cases] of byDesign) {
  test(`report-schema parity: ${design}`, async ({ page }) => {
    const xml = cases[0]!.xml;
    const outcome = await page.evaluate((designXml) => window.__air.runDesign(designXml), xml);

    for (const c of cases) {
      const actual = outcome.reportJson[c.testId];
      expect(actual, `no browser report for ${design}/${c.testId}; notes: ${outcome.notes.join(" | ")}`).toBeDefined();
      const parsed = JSON.parse(actual as string);

      if (parsed.convergence.converged === false) {
        // DISCLOSED browser-side non-convergence: the engine ran as-written and
        // could not solve it (native ngspice can). Assert the HONEST terminal
        // shape — the report is still schema-correct, it just truthfully says
        // the browser engine did not converge. This is NOT faked parity.
        expect(parsed.convergence, `${design}/${c.testId} honest terminal`).toMatchObject({
          converged: false,
          rung: null,
          aids_required: false,
          terminal: true,
        });
        expect(parsed.convergence.attempts[0].ngspice_missing).toBeUndefined();
        expect(typeof parsed.convergence.note).toBe("string");
        continue;
      }

      // Converged: the browser ran as-written (rung 1). The corpus designs that
      // converge do so natively on rung 1, so the browser's convergence section
      // is byte-identical to the oracle's rung-1 section.
      expect(parsed.convergence, `${design}/${c.testId} convergence`).toMatchObject({
        converged: true,
        rung: 1,
        aids_required: false,
        terminal: false,
        note: null,
      });
      expect(parsed.backend, `${design}/${c.testId} backend`).toBe("ngspice");

      const diffs = compareReport(c.expectedReport, actual as string, RTOL);
      expect(diffs, `${design}/${c.testId} report diffs:\n${diffs.join("\n")}`).toEqual([]);
    }
  });
}

test("waveform CSV export is FORMAT-parity with the corpus (header + column structure)", async ({ page }) => {
  // Run one design and assert its exported CSV header matches the oracle's
  // canonical `time_s,v(<net>)` form with comma columns and LF endings. Values
  // differ (engine skew) — this pins the FORMAT, not the numbers.
  const design = [...byDesign.values()][0]![0]!;
  const outcome = await page.evaluate((designXml) => window.__air.runDesign(designXml), design.xml);
  const csvKeys = Object.keys(outcome.csv);
  expect(csvKeys.length, "expected at least one retained waveform CSV").toBeGreaterThan(0);
  for (const key of csvKeys) {
    const csv = outcome.csv[key]!;
    const lines = csv.split("\n");
    expect(lines[0], `${key} header`).toMatch(/^time_s,v\([^)]+\)$/);
    expect(csv.includes("\r"), `${key} must use LF endings`).toBe(false);
    expect(csv.endsWith("\n"), `${key} must have a trailing newline`).toBe(true);
    for (const line of lines.slice(1).filter((l) => l.length > 0)) {
      expect(line, `${key} data row`).toMatch(/^-?[\d.eE+-]+,-?[\d.eE+-]+$/);
    }
  }
});

// Tripwire: a SELF-CONTAINED run of every design that pins how many report cases
// the browser converges vs. honestly diverges on. If a bug turns a CONVERGING
// design terminal, `converged` drops and this fails — the divergence count
// cannot silently grow. Counts reflect the committed corpus at #14 time: 4
// report cases converge; 1 (a MOSFET+behavioural-source design native ngspice
// solves but eecircuit reports singular) honestly diverges. No corpus name is
// referenced — only the tallies (guardrails R4). Bump if the corpus changes.
test("convergence tally is pinned (a regression cannot hide as a divergence)", async ({ page }) => {
  let converged = 0;
  let terminal = 0;
  for (const [, cases] of byDesign) {
    const outcome = await page.evaluate((designXml) => window.__air.runDesign(designXml), cases[0]!.xml);
    for (const c of cases) {
      const parsed = JSON.parse(outcome.reportJson[c.testId] as string);
      if (parsed.convergence.converged) converged += 1;
      else terminal += 1;
    }
  }
  expect(converged + terminal).toBe(CASES.length);
  expect(converged).toBe(4);
  expect(terminal).toBe(1);
});
