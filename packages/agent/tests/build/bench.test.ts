/**
 * The build benchmark, run in MOCK mode as a CI test (issue #107 deliverable 3).
 *
 * This is the CI-safe surface: it validates the harness + scorer-integration
 * MECHANICS + the stop conditions deterministically, OFFLINE. air-ts is the real
 * gate (Vitest alias), the mock provider replays scripted builds, and the
 * objective scorer is INJECTED as a deterministic offline function so the test
 * needs no python / ngspice. The real Python scorer's DISCRIMINATION (a golden
 * passes, a broken design fails the right criterion) is proven separately by
 * tests/test_build_specs.py in the Python CI — injecting the scorer here is not
 * weakening it; it is the same split #19 uses (mock loop mechanics in CI, real
 * provider quality measured live).
 *
 * The mechanics proven here:
 *   1. a CORRECT build (a golden staged) scores `built` and stops `built`;
 *   2. a WRONG build (a design missing a required component) fails the RIGHT
 *      criterion (required_components) and is NOT `built`;
 *   3. NO staged design stops `no_build`;
 *   4. re-staging the SAME design stops `no_progress`;
 *   5. every design write goes through the real air-ts gate (a broken design that
 *      does not validate is rejected by the gate, never scored as a build).
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
import { MockProvider, type MockFixture, type ScriptedEvent } from "../../src/index.js";
import { runBuildBenchmark, stageDesignTurns, type AirTsFacade } from "../../bench/build/runner.js";
import { runBuildLoop, BUILD_SHELL_XML } from "../../bench/build/loop.js";
import { buildEngine } from "../../bench/build/engine.js";
import { loadBuildSpecs, repoRoot } from "../../bench/build/specs.js";
import { mockFixtureForSpec } from "../../bench/build/mock_fixtures.js";
import type { BuildScore, ScoreFn } from "../../bench/build/scorer.js";

const air: AirTsFacade = {
  normalize,
  validate: validate as unknown as AirTsFacade["validate"],
  applyPatch,
  previewPatch: previewPatch as unknown as AirTsFacade["previewPatch"],
  COMPONENT_SPECS: COMPONENT_SPECS as Record<string, unknown>,
  MCUS: MCUS as Record<string, unknown>,
};

/**
 * A deterministic, OFFLINE scorer. It runs the two ngspice-free criteria for real
 * on the design + the real air-ts validate:
 *   - erc_clean            via air-ts validate (no error diagnostics);
 *   - required_components   by counting type="..." components in the design.
 * Connectivity / firmware_intent / sim_assertion it treats as pass (the real
 * predicate solver + physics are the Python scorer's job, proven by the golden
 * suite). This is enough to prove the harness routes built vs the-right-failure
 * and drives the stop conditions — exactly the CI mechanics under test.
 */
const offlineScorer: ScoreFn = async (designXml, criteria): Promise<BuildScore> => {
  const errors = air.validate(designXml).filter((d) => d.severity === "error");
  const critMap: Record<string, boolean> = {};
  if (criteria.erc_clean) {
    critMap["erc_clean"] = errors.length === 0;
    if (errors.length > 0) {
      return {
        built: false,
        failed_criterion: "erc_clean",
        detail: `not ERC-clean: ${errors.map((e) => e.code).join(",")}`,
        criteria: critMap,
        sim_backend: null,
        sim_value: null,
      };
    }
  }
  // required_components: count components by type via a robust regex on the XML.
  const counts = countComponentTypes(designXml);
  for (const rc of criteria.required_components) {
    const have = counts[rc.type] ?? 0;
    const ok = have >= rc.count;
    critMap["required_components"] = (critMap["required_components"] ?? true) && ok;
    if (!ok) {
      return {
        built: false,
        failed_criterion: "required_components",
        detail: `need >= ${rc.count} of type '${rc.type}', found ${have}`,
        criteria: critMap,
        sim_backend: null,
        sim_value: null,
      };
    }
  }
  critMap["connectivity"] = true;
  critMap["firmware_intent"] = true;
  if (criteria.sim_assertion) critMap["sim_assertion"] = true;
  return { built: true, failed_criterion: null, detail: "", criteria: critMap, sim_backend: null, sim_value: null };
};

function countComponentTypes(xml: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /<component\b[^>]*\btype="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const ty = m[1]!;
    counts[ty] = (counts[ty] ?? 0) + 1;
  }
  return counts;
}

const engine = () => buildEngine(air, { mode: "mock", repoRoot: repoRoot() });

describe("build benchmark (mock mode): harness + scorer mechanics + stop conditions", () => {
  it("scores a CORRECT build (golden staged) as built via the runner", async () => {
    const report = await runBuildBenchmark({
      air,
      mode: "mock",
      repoRoot: repoRoot(),
      providerLabel: "mock",
      date: "2026-07-05",
      only: ["led_esp32c3_single"],
      mockFixtureForSpec,
      scoreFn: offlineScorer,
    });
    expect(report.totalSpecs).toBe(1);
    const c = report.cases[0]!;
    expect(c.id).toBe("led_esp32c3_single");
    expect(c.built, `expected built (${c.stopReason} / ${c.failedCriterion})`).toBe(true);
    expect(c.stopReason).toBe("built");
    expect(c.tokens).toBeGreaterThan(0);
    expect(c.turns).toBeGreaterThanOrEqual(1);
    expect(report.builtCount).toBe(1);
  });

  it("builds two correct specs and produces a stable, serializable report", async () => {
    const report = await runBuildBenchmark({
      air,
      mode: "mock",
      repoRoot: repoRoot(),
      providerLabel: "mock",
      date: "2026-07-05",
      only: ["led_esp32c3_single", "led_atmega_npn_driver"],
      mockFixtureForSpec,
      scoreFn: offlineScorer,
    });
    expect(report).toMatchObject({ provider: "mock", mode: "mock", date: "2026-07-05", totalSpecs: 2 });
    expect(report.builtCount).toBe(2);
    expect(report.cases.map((c) => c.id).sort()).toEqual(["led_atmega_npn_driver", "led_esp32c3_single"]);
    for (const c of report.cases) expect(c.built).toBe(true);
  });

  it("fails the RIGHT criterion (required_components) for a WRONG build", async () => {
    const spec = getSpec("led_esp32c3_single");
    // Stage a gate-VALID design that is missing the required diode → the scorer
    // must fail required_components, not something else, and the build is not built.
    const wrong = WRONG_DESIGN_MISSING_DIODE;
    const provider = new MockProvider({ turns: stageDesignTurns(wrong, "missing the diode", "w1") });
    const result = await runBuildLoop({
      spec,
      provider,
      hooks: engine(),
      scoreFn: offlineScorer,
      idFactory: makeIds("wrong"),
    });
    expect(result.reason).not.toBe("built");
    expect(result.score?.built).toBe(false);
    expect(result.score?.failed_criterion).toBe("required_components");
  });

  it("stops `no_build` when the model stages no design", async () => {
    const spec = getSpec("led_esp32c3_single");
    const noStage: ScriptedEvent[] = [
      { type: "text-delta", text: "I cannot build this." },
      { type: "usage", inputTokens: 20, outputTokens: 5 },
      { type: "done", stopReason: "stop" },
    ];
    const provider = new MockProvider({ turns: [noStage] });
    const result = await runBuildLoop({
      spec,
      provider,
      hooks: engine(),
      scoreFn: offlineScorer,
      idFactory: makeIds("nobuild"),
    });
    expect(result.reason).toBe("no_build");
    expect(result.finalXml).toBe(BUILD_SHELL_XML);
  });

  it("stops `no_progress` when the model re-stages the same design", async () => {
    const spec = getSpec("led_esp32c3_single");
    // Turn budget 3, but the model stages the SAME (wrong) design on iterations
    // 0 and 1 → iteration 1 detects no change and stops no_progress.
    const wrong = WRONG_DESIGN_MISSING_DIODE;
    const fixture: MockFixture = {
      turns: [
        ...stageDesignTurns(wrong, "attempt 1", "np1"),
        ...stageDesignTurns(wrong, "attempt 2 (same)", "np2"),
      ],
    };
    const provider = new MockProvider(fixture);
    const result = await runBuildLoop({
      spec,
      provider,
      hooks: engine(),
      scoreFn: offlineScorer,
      turnBudget: 3,
      idFactory: makeIds("np"),
    });
    expect(result.reason).toBe("no_progress");
    expect(result.iterations).toBe(2);
  });

  it("the real gate REJECTS an unparseable design (never scored as a build)", async () => {
    const spec = getSpec("led_esp32c3_single");
    // A malformed (unparseable) design: normalize THROWS, the #96 gate rejects it,
    // no proposal is produced, and — with nothing ever staged — the loop ends
    // no_build. The scorer is never even reached (score stays null).
    const invalid = `<system name="bad" ir_version="0.1"><metadata><title>x</unclosed`;
    const provider = new MockProvider({ turns: stageDesignTurns(invalid, "invalid design", "bad1") });
    const result = await runBuildLoop({
      spec,
      provider,
      hooks: engine(),
      scoreFn: offlineScorer,
      idFactory: makeIds("bad"),
    });
    expect(result.reason).toBe("no_build");
    expect(result.score).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Test fixtures.
// --------------------------------------------------------------------------- //

function getSpec(id: string) {
  const spec = loadBuildSpecs().find((s) => s.id === id);
  if (!spec) throw new Error(`spec ${id} not found`);
  return spec;
}

function makeIds(seed: string): () => string {
  let n = 0;
  return () => `${seed}-${++n}`;
}

// A gate-valid ESP32-C3 LED design that OMITS the diode the spec requires — used
// to prove the scorer fails required_components (the right criterion), not erc.
const WRONG_DESIGN_MISSING_DIODE = `<system name="led_missing_diode" ir_version="0.1">
  <metadata><title>LED (missing diode)</title><description>Deliberately omits the LED to exercise required_components failure.</description><author>test</author></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="v3v3" role="power" nominal_voltage="3.3V"/>
    <net id="led_drive" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="v3v3"/><pin name="GND" net="gnd"/>
      <pin name="GPIO2" net="led_drive" function="GPIO_OUT"/>
    </component>
    <component id="R1" type="resistor"><value>330</value>
      <pin name="1" net="led_drive"/><pin name="2" net="gnd"/></component>
  </components>
  <tests/>
  <simulation_profiles/>
</system>`;
