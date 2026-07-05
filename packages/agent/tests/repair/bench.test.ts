/**
 * The repair benchmark, run in MOCK mode as a CI test (issue #19 deliverable 3).
 *
 * This is the CI-safe surface: the benchmark scores every failing example with
 * the MockProvider replaying each case's deterministic scripted fix, driven
 * through the loop + the REAL air-ts gate. It proves the loop MECHANICS converge
 * on every real design — the flagship demo's mechanism, deterministically.
 *
 * air-ts is resolved by the Vitest alias here and passed into the runner as the
 * facade, so the SAME runner the CLI uses runs against the real gate.
 */

import { describe, it, expect } from "vitest";
import {
  normalize,
  validate,
  applyPatch,
  previewPatch,
  COMPONENT_SPECS,
  MCUS,
} from "air-ts";
import { runBenchmark, type AirTsFacade } from "../../bench/runner.js";
import { CASE_NAMES } from "../../bench/cases.js";

const air: AirTsFacade = {
  normalize,
  validate: validate as unknown as AirTsFacade["validate"],
  applyPatch,
  previewPatch: previewPatch as unknown as AirTsFacade["previewPatch"],
  COMPONENT_SPECS: COMPONENT_SPECS as Record<string, unknown>,
  MCUS: MCUS as Record<string, unknown>,
};

describe("repair benchmark (mock mode): loop mechanics over every failing example", () => {
  it("fixes all six failing examples within the iteration budget", async () => {
    const report = await runBenchmark({
      air,
      mode: "mock",
      providerLabel: "mock",
      maxIterations: 5,
      date: "2026-07-05",
    });

    expect(report.totalCases).toBe(CASE_NAMES.length);
    expect(report.mode).toBe("mock");
    // The mock scripted fixes are known-good; every case converges to `fixed`.
    expect(report.fixedCount).toBe(CASE_NAMES.length);
    for (const c of report.cases) {
      expect(c.fixed, `${c.name} should be fixed (${c.stopReason})`).toBe(true);
      expect(c.stopReason).toBe("fixed");
      // Each converges with exactly one applied gated patch, within the budget.
      expect(c.appliedPatches).toBe(1);
      expect(c.iterations).toBeLessThanOrEqual(5);
      expect(c.tokens).toBeGreaterThan(0);
    }
  });

  it("produces a stable, serializable report artifact", async () => {
    const report = await runBenchmark({
      air,
      mode: "mock",
      providerLabel: "mock",
      maxIterations: 5,
      date: "2026-07-05",
    });
    // The report shape the committed live results mirror.
    expect(report).toMatchObject({
      provider: "mock",
      mode: "mock",
      date: "2026-07-05",
      maxIterations: 5,
      totalCases: 6,
      fixedCount: 6,
    });
    expect(report.cases.map((c) => c.name).sort()).toEqual([...CASE_NAMES].sort());
  });
});
