/**
 * Focused unit tests for the tool runtime, budgets, truncation, and the Stop
 * (abort) path — the pieces the scenario suite exercises end to end but that
 * deserve isolated assertions.
 */

import { describe, it, expect } from "vitest";
import {
  ToolRuntime,
  BudgetCounter,
  capToolResult,
  capString,
  summarizeStderr,
  stableStringify,
  DEFAULT_RESULT_CHAR_CAP,
  GOLDEN_DESIGN,
} from "../../src/index.js";
import { realAirTsEngine, slowSimulate } from "./engineAdapter.js";

const noAbort = () => new AbortController().signal;

describe("ToolRuntime: introspection + gate tools", () => {
  it("get_design returns the current xml + version + diagnostics", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 3 }, { hooks: realAirTsEngine() });
    const exec = await rt.execute("get_design", {}, noAbort());
    const parsed = JSON.parse(exec.result);
    expect(parsed.version).toBe(3);
    expect(parsed.design_xml).toContain("<system");
  });

  it("list_registry_components returns component + mcu lists", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const exec = await rt.execute("list_registry_components", {}, noAbort());
    const parsed = JSON.parse(exec.result);
    expect(Array.isArray(parsed.components)).toBe(true);
    expect(parsed.components).toContain("resistor");
  });

  it("set_design with an invalid design is gate-rejected and stages nothing", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const exec = await rt.execute(
      "set_design",
      { design_xml: '<system name="x" ir_version="0.1"><nets/></system>' },
      noAbort(),
    );
    expect(exec.gateRejected).toBe(true);
    expect(exec.staged).toBeUndefined();
    expect(rt.stagedProposals()).toHaveLength(0);
    expect(exec.result).toContain("validation_failed");
  });

  it("propose_patch with a non-applying patch is fed back, not thrown", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const exec = await rt.execute(
      "propose_patch",
      { patch_xml: `<patch id="x"><replace path="/system/components/component[@id='NOPE']/value"><value>1k</value></replace></patch>` },
      noAbort(),
    );
    expect(exec.gateRejected).toBe(true);
    expect(exec.result).toContain("patch_did_not_apply");
    expect(rt.stagedProposals()).toHaveLength(0);
  });
});

describe("ToolRuntime: run_simulation Stop / timeout", () => {
  it("run_simulation aborts within a few ms when the signal fires (Stop)", async () => {
    const rt = new ToolRuntime(
      { xml: GOLDEN_DESIGN, version: 0 },
      { hooks: realAirTsEngine({ simulate: slowSimulate(10_000) }) },
    );
    const controller = new AbortController();
    const started = Date.now();
    const p = rt.execute("run_simulation", {}, controller.signal);
    // Fire Stop almost immediately.
    setTimeout(() => controller.abort(), 5);
    const exec = await p;
    const elapsed = Date.now() - started;
    expect(exec.aborted).toBe(true);
    expect(exec.result).toContain("simulation_canceled");
    // The Stop must interrupt well under the 500ms acceptance bar.
    expect(elapsed).toBeLessThan(500);
  });

  it("run_simulation cancels on the per-call timeout", async () => {
    const rt = new ToolRuntime(
      { xml: GOLDEN_DESIGN, version: 0 },
      { hooks: realAirTsEngine({ simulate: slowSimulate(10_000) }), simTimeoutCeilingMs: 5000 },
    );
    const exec = await rt.execute("run_simulation", { timeout_ms: 20 }, noAbort());
    expect(exec.result).toContain("simulation_timeout");
  });

  it("read_waveform before any run reports no_run", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const exec = await rt.execute("read_waveform", { net: "sense" }, noAbort());
    expect(exec.result).toContain("no_run");
  });

  it("read_waveform after a run returns a DECIMATED summary (bounded points)", async () => {
    const rt = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    await rt.execute("run_simulation", {}, noAbort());
    const exec = await rt.execute("read_waveform", { net: "sense" }, noAbort());
    const parsed = JSON.parse(exec.result);
    expect(parsed.returnedPoints).toBeLessThanOrEqual(256);
    expect(parsed.totalPoints).toBeGreaterThanOrEqual(parsed.returnedPoints);
  });
});

describe("BudgetCounter", () => {
  it("startIteration increments until the iteration cap, then reports exhaustion", () => {
    const b = new BudgetCounter({ maxIterations: 2, maxTokens: 1e9, maxWallMs: 1e9 });
    expect(b.startIteration()).toBeNull(); // 1
    expect(b.startIteration()).toBeNull(); // 2
    expect(b.startIteration()).toBe("iterations"); // blocked, not incremented
    expect(b.usage().iterations).toBe(2);
  });

  it("token budget trips after enough usage", () => {
    const b = new BudgetCounter({ maxIterations: 1e9, maxTokens: 100, maxWallMs: 1e9 });
    b.addTokens(60, 60);
    expect(b.check()).toBe("tokens");
  });

  it("wall-time budget uses the injected clock (deterministic)", () => {
    let t = 1000;
    const b = new BudgetCounter({ maxIterations: 1e9, maxTokens: 1e9, maxWallMs: 500 }, () => t);
    expect(b.check()).toBeNull();
    t = 1600;
    expect(b.check()).toBe("wall_time");
  });
});

describe("tool-result truncation (boundedness)", () => {
  it("capString keeps head+tail with an explicit [truncated] marker", () => {
    const big = "A".repeat(5000) + "TAILMARK" + "B".repeat(5000);
    const out = capString(big, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain("[truncated");
    // Head is preserved.
    expect(out.startsWith("A")).toBe(true);
    // Tail is preserved.
    expect(out.endsWith("B")).toBe(true);
  });

  it("capToolResult never exceeds the cap on a pathological payload", () => {
    const payload = { blob: "x".repeat(100_000), items: Array.from({ length: 1000 }, (_, i) => i) };
    const out = capToolResult(payload, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain("[truncated");
  });

  it("stableStringify sorts keys (determinism)", () => {
    const a = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = stableStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("summarizeStderr keeps only the last N lines with a count header", () => {
    const lines = Array.from({ length: 42 }, (_, i) => `line ${i}`);
    const out = summarizeStderr(lines, 5);
    expect(out).toContain("42 stderr lines");
    expect(out).toContain("line 41");
    expect(out).not.toContain("line 10");
  });

  it("DEFAULT_RESULT_CHAR_CAP is a sane bound", () => {
    expect(DEFAULT_RESULT_CHAR_CAP).toBeGreaterThan(1000);
    expect(DEFAULT_RESULT_CHAR_CAP).toBeLessThan(50_000);
  });
});
