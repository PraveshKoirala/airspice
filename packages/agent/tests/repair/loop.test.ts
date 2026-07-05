/**
 * Repair-loop mechanics (issue #19) — the CI-safe surface.
 *
 * Every scenario drives the REAL loop + tool runtime with the MockProvider
 * replaying a scripted tool-call sequence, and with EngineHooks backed by the
 * REAL air-ts gate (normalize → validate → applyPatch). So these prove the
 * actual production paths, not stubs:
 *
 *   - convergence     a broken design → a real gated patch → passing → `fixed`.
 *   - no_progress     two rounds with the SAME semantic diagnostic signature →
 *                     `no_progress` (semantic, not string equality of reports).
 *   - budget          a token budget is spent mid-run → `budget_exhausted`.
 *   - no_fix_proposed a patch the GATE rejects stages nothing → distinct stop.
 *   - gate invariant  every applied step is a gated ValidatedDesign (unforgeable).
 *   - #45 rung>=2      a sim that PASSED on a high rung is NOT repaired → `fixed`.
 *   - #45 terminal     a terminal-convergence sim steers the context to topology.
 *
 * The mock replays turns by a session-global index, and the loop runs ONE
 * `runConversation` per iteration (each conversation consumes provider turns
 * until the model stops asking for tools). So a fixture scripts, per iteration:
 * a turn that calls `propose_patch` (stopReason tool_use) then a terminal turn
 * (stopReason stop). Beyond the script the mock yields a benign `done`.
 */

import { describe, it, expect } from "vitest";
import {
  MockProvider,
  runRepairLoop,
  diagnosticSignature,
  signaturesEqual,
  evaluateDesign,
  assembleRepairContext,
  assertBudget,
  isFixed,
  type MockFixture,
  type ScriptedEvent,
  type RepairLoopEvent,
  type SimulationReportLike,
  type GateDiagnostic,
} from "../../src/index.js";
import { realAirTsEngine } from "../tools/engineAdapter.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------------------- //
// Helpers.
// --------------------------------------------------------------------------- //

function example(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../examples/failing/${name}.air.xml`, import.meta.url)),
    "utf-8",
  );
}

function makeIdFactory(): () => string {
  let n = 0;
  return () => `proposal-${++n}`;
}

/** A turn that proposes a patch, then a terminal turn — one loop iteration. */
function proposeTurn(patchXml: string, summary: string, id = "p"): ScriptedEvent[][] {
  return [
    [
      { type: "text-delta", text: `Editing circuit... ${summary}` },
      { type: "tool-call", id, name: "propose_patch", args: { patch_xml: patchXml, summary } },
      { type: "usage", inputTokens: 80, outputTokens: 20 },
      { type: "done", stopReason: "tool_use" },
    ],
    [
      { type: "text-delta", text: "Staged the fix." },
      { type: "done", stopReason: "stop" },
    ],
  ];
}

function sink() {
  const events: RepairLoopEvent[] = [];
  return {
    events,
    onEvent: (e: RepairLoopEvent) => events.push(e),
    of<T extends RepairLoopEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<RepairLoopEvent, { type: T }> => e.type === type);
    },
  };
}

/** The real fix for missing_ground: add a ground net + the MCU's GND pin. */
const MISSING_GROUND_FIX =
  `<patch id="fix"><reason>add ground net and MCU ground pin</reason>` +
  `<add path="/system/nets"><net id="gnd" role="ground"/></add>` +
  `<add path="/system/components/component[@id='U_MCU']"><pin name="GND" net="gnd"/></add>` +
  `</patch>`;

// --------------------------------------------------------------------------- //
// (1) Convergence: a broken design → one gated patch → passing → `fixed`.
// --------------------------------------------------------------------------- //

describe("repair loop: convergence to a fix", () => {
  it("repairs missing_ground with a real gated patch and stops `fixed`", async () => {
    const fixture: MockFixture = { turns: proposeTurn(MISSING_GROUND_FIX, "add ground") };
    const s = sink();
    const result = await runRepairLoop({
      design: example("missing_ground"),
      provider: new MockProvider(fixture),
      hooks: realAirTsEngine(),
      idFactory: makeIdFactory(),
      onEvent: s.onEvent,
    });

    expect(result.reason).toBe("fixed");
    expect(isFixed(result.reason)).toBe(true);
    // Exactly one gated step was applied; the final design contains the ground net.
    expect(result.appliedSteps).toHaveLength(1);
    expect(result.finalXml).toContain('role="ground"');
    // The applied step carries a gated (unforgeable) ValidatedDesign + undo target.
    const step = result.appliedSteps[0]!;
    expect(step.design.xml).toBe(result.finalXml);
    expect(step.previousXml).toContain("missing_ground");
    // The timeline recorded the diagnosis + the applied patch.
    expect(s.of("patch-applied")).toHaveLength(1);
    expect(s.of("done")).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- //
// (2) No-progress: SAME semantic signature two rounds → `no_progress`.
// --------------------------------------------------------------------------- //

describe("repair loop: no-progress (semantic) stop", () => {
  it("stops `no_progress` when two rounds leave the same diagnostic signature", async () => {
    // A patch that changes the metadata title only: it applies + validates (so a
    // proposal STAGES), but leaves the DESIGN's validation diagnostics identical
    // — the missing-ground errors persist. Two such rounds => same signature.
    const noopFix =
      `<patch id="noop"><reason>touch title</reason>` +
      `<replace path="/system/metadata/title"><title>Missing Ground v2</title></replace>` +
      `</patch>`;
    const noopFix2 =
      `<patch id="noop2"><reason>touch title again</reason>` +
      `<replace path="/system/metadata/title"><title>Missing Ground v3</title></replace>` +
      `</patch>`;
    // The gate REJECTS a patch whose result still has errors (missing_ground
    // stays broken), so a title-only patch on a broken design would NOT stage.
    // Use a design that VALIDATES but whose SIM fails identically each round, so
    // a cosmetic patch stages yet the signature is unchanged. We simulate that
    // via a custom engine whose validate() is clean and whose simulate() fails
    // with a fixed report; the title patch keeps validation clean.
    const design = example("bad_adc_divider");
    // Strip the firmware so it validates (ADC error is firmware-derived), leaving
    // a design that validates but whose sim we force to fail identically.
    const cleanDesign = design.replace(/<firmware>[\s\S]*?<\/firmware>/, "");

    const failingReport: SimulationReportLike = {
      profile: "analog_only",
      status: "failed",
      reports: [
        {
          test: "battery_adc_nominal",
          status: "failed",
          diagnostics: [
            {
              code: "ASSERT_FAILED",
              message: "battery_sense outside range",
              related_elements: ["battery_adc_nominal", "battery_sense"],
              severity: "error",
            },
          ],
          convergence: { terminal: false, converged: true, rung: 1, note: null },
          measurements: { "v(battery_sense)": "1.9 V" },
        },
      ],
      notes: [],
      runId: "r1",
    };
    // A second report differing ONLY in float noise — same semantic signature.
    const failingReport2: SimulationReportLike = JSON.parse(JSON.stringify(failingReport));
    (failingReport2.reports[0] as { measurements: Record<string, string> }).measurements[
      "v(battery_sense)"
    ] = "1.90000001 V";

    let simCall = 0;
    const hooks = realAirTsEngine({
      simulate: async () => {
        simCall++;
        return simCall <= 1 ? failingReport : failingReport2;
      },
    });

    const fixture: MockFixture = {
      turns: [...proposeTurn(noopFix, "touch title", "n1"), ...proposeTurn(noopFix2, "touch title 2", "n2")],
    };
    const result = await runRepairLoop({
      design: cleanDesign,
      provider: new MockProvider(fixture),
      hooks,
      idFactory: makeIdFactory(),
      maxIterations: 5,
    });

    // The signatures matched on the second round → no_progress (NOT max_iterations).
    expect(result.reason).toBe("no_progress");
  });
});

// --------------------------------------------------------------------------- //
// (3) Budget: a token budget spent mid-run → `budget_exhausted`.
// --------------------------------------------------------------------------- //

describe("repair loop: budget stop", () => {
  it("stops `budget_exhausted` when the per-iteration token budget trips with no fix", async () => {
    // A turn that burns tokens and asks for a tool forever, but never stages a
    // gated fix (unknown-but-valid tool). The conversation's token budget cuts it
    // off; with no applied step, the loop's reason is budget_exhausted.
    const burnTurn: ScriptedEvent[] = [
      { type: "tool-call", id: "reg", name: "list_registry_components", args: {} },
      { type: "usage", inputTokens: 5000, outputTokens: 5000 },
      { type: "done", stopReason: "tool_use" },
    ];
    const fixture: MockFixture = { turns: Array.from({ length: 20 }, () => burnTurn) };
    const result = await runRepairLoop({
      design: example("missing_ground"),
      provider: new MockProvider(fixture),
      hooks: realAirTsEngine(),
      idFactory: makeIdFactory(),
      maxTokensPerTurn: 1024,
      maxIterations: 3,
    });
    expect(result.reason).toBe("budget_exhausted");
    expect(result.appliedSteps).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- //
// (4) No fix proposed: the gate REJECTS every patch → distinct stop.
// --------------------------------------------------------------------------- //

describe("repair loop: no gated fix could be produced", () => {
  it("stops `no_fix_proposed` when the model's patch fails the gate (nothing staged)", async () => {
    // A patch that applies but leaves the design STILL broken (only touches the
    // title, ground still missing) → the gate rejects it → nothing is staged.
    const badFix =
      `<patch id="bad"><reason>cosmetic only, does not fix ground</reason>` +
      `<replace path="/system/metadata/title"><title>Still Broken</title></replace>` +
      `</patch>`;
    const fixture: MockFixture = { turns: proposeTurn(badFix, "cosmetic", "b") };
    const result = await runRepairLoop({
      design: example("missing_ground"),
      provider: new MockProvider(fixture),
      hooks: realAirTsEngine(),
      idFactory: makeIdFactory(),
    });
    expect(result.reason).toBe("no_fix_proposed");
    expect(result.appliedSteps).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------- //
// (5) #45 convergence awareness.
// --------------------------------------------------------------------------- //

describe("repair loop: #45 convergence awareness", () => {
  it("does NOT repair a design whose sim PASSED on a high ladder rung (rung>=2)", async () => {
    // A design that VALIDATES clean; its sim PASSED but only on rung 3 (aids
    // required). A passing sim is not a defect — the loop must stop `fixed` on
    // iteration 0 WITHOUT proposing any patch.
    const design = example("bad_adc_divider").replace(/<firmware>[\s\S]*?<\/firmware>/, "");
    const passedHighRung: SimulationReportLike = {
      profile: "analog_only",
      status: "passed",
      reports: [
        {
          test: "battery_adc_nominal",
          status: "passed",
          diagnostics: [],
          convergence: { terminal: false, converged: true, rung: 3, note: null },
          measurements: { "v(battery_sense)": "1.04 V" },
        },
      ],
      notes: [],
      runId: "r1",
    };
    const hooks = realAirTsEngine({ simulate: async () => passedHighRung });
    // A fixture that WOULD propose a patch if asked — proving the loop never asks.
    const fixture: MockFixture = { turns: proposeTurn(MISSING_GROUND_FIX, "should-not-run") };
    const result = await runRepairLoop({
      design,
      provider: new MockProvider(fixture),
      hooks,
      idFactory: makeIdFactory(),
    });
    expect(result.reason).toBe("fixed");
    expect(result.appliedSteps).toHaveLength(0); // never repaired a passing design.
  });

  it("a terminal-convergence sim steers the assembled context to TOPOLOGY first", async () => {
    const design = example("bad_adc_divider").replace(/<firmware>[\s\S]*?<\/firmware>/, "");
    const terminalReport: SimulationReportLike = {
      profile: "analog_only",
      status: "failed",
      reports: [
        {
          test: "battery_adc_nominal",
          status: "failed",
          diagnostics: [],
          convergence: {
            terminal: true,
            converged: false,
            rung: null,
            note: "did not converge after every numerical aid; inspect topology (floating node / missing DC path to ground)",
          },
          measurements: {},
        },
      ],
      notes: [],
      runId: "r1",
    };
    const hooks = realAirTsEngine({ simulate: async () => terminalReport });
    const evaluation = await evaluateDesign(design, hooks, new AbortController().signal);
    expect(evaluation.topologyFirst).toBe(true);
    expect(evaluation.passes).toBe(false);

    const context = assembleRepairContext(
      { designXml: design, evaluation, history: [], iteration: 0, maxIterations: 5 },
      24_000,
    );
    // The topology-first hint appears, and BEFORE the "CURRENT DESIGN" section.
    const topoIdx = context.indexOf("CONVERGENCE (topology first)");
    const designIdx = context.indexOf("CURRENT DESIGN");
    expect(topoIdx).toBeGreaterThanOrEqual(0);
    expect(designIdx).toBeGreaterThan(topoIdx);
  });
});

// --------------------------------------------------------------------------- //
// (6) Semantic signature: float noise does NOT change the signature.
// --------------------------------------------------------------------------- //

describe("repair loop: semantic diagnostic signature", () => {
  it("two reports differing only in float/timestamp noise have the SAME signature", () => {
    const mk = (v: string): SimulationReportLike => ({
      profile: "analog_only",
      status: "failed",
      reports: [
        {
          test: "t",
          status: "failed",
          diagnostics: [
            {
              code: "ASSERT_FAILED",
              message: `sense outside range at ${v}`,
              related_elements: ["t", "sense"],
              severity: "error",
            },
          ],
          convergence: { terminal: false, converged: true, rung: 1, note: null },
          measurements: { "v(sense)": v },
        },
      ],
    });
    const validation: GateDiagnostic[] = [];
    const a = diagnosticSignature(validation, mk("1.900000 V"));
    const b = diagnosticSignature(validation, mk("1.900314 V"));
    expect(signaturesEqual(a, b)).toBe(true);
  });

  it("a different failing assertion subject changes the signature (progress)", () => {
    const base: SimulationReportLike = {
      profile: "p",
      status: "failed",
      reports: [
        {
          test: "t",
          status: "failed",
          diagnostics: [
            { code: "ASSERT_FAILED", related_elements: ["t", "sense"], severity: "error", message: "" },
          ],
          convergence: { terminal: false, converged: true, rung: 1, note: null },
        },
      ],
    };
    const other: SimulationReportLike = JSON.parse(JSON.stringify(base));
    const otherDiags = (other.reports[0] as { diagnostics: Array<{ related_elements: string[] }> }).diagnostics;
    otherDiags[0]!.related_elements = ["t", "rail"];
    const a = diagnosticSignature([], base);
    const b = diagnosticSignature([], other);
    expect(signaturesEqual(a, b)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// (7) Fresh context: the hard per-iteration budget throws rather than clip.
// --------------------------------------------------------------------------- //

describe("repair loop: fresh-context hard budget", () => {
  it("assertBudget THROWS when an assembled context would exceed the budget", () => {
    const big = "x".repeat(5000);
    expect(() => assertBudget(big, 1000)).toThrow(/growing context is a bug/);
    expect(() => assertBudget("small", 1000)).not.toThrow();
  });

  it("assembleRepairContext stays within its hard budget even for a large design", async () => {
    const design = example("phase3_failure");
    const hooks = realAirTsEngine();
    const evaluation = await evaluateDesign(design, hooks, new AbortController().signal);
    const budget = 8_000;
    const context = assembleRepairContext(
      { designXml: design, evaluation, history: [], iteration: 2, maxIterations: 5 },
      budget,
    );
    expect(context.length).toBeLessThanOrEqual(budget);
  });
});
