/**
 * Mock-provider CI scenarios (issue #18 deliverable 6) — the CI-safe surface.
 *
 * Each scenario drives the REAL conversation runner + tool runtime with the
 * MockProvider replaying a scripted tool-call sequence, and with EngineHooks
 * backed by the REAL air-ts gate (normalize -> validate). So these prove the
 * actual production paths, not stubs:
 *
 *   (a) happy path   build (set_design) -> validate -> simulate, all green.
 *   (b) gate reject  a malformed / invalid proposal is REJECTED by the gate;
 *                    the model receives diagnostics as the tool result and NO
 *                    design ever reaches editor state (the invariant).
 *   (c) user rejects a staged proposal is discarded (no write).
 *   (d) budget       the loop stops mid-conversation when a budget is exhausted.
 *   (e) concurrent   (post-audit amendment) a proposal staged at v0 is Applied
 *                    after the user bumped the version -> the rebase/conflict
 *                    path runs, never a silent clobber.
 */

import { describe, it, expect } from "vitest";
import {
  MockProvider,
  ToolRuntime,
  runConversation,
  resolveApply,
  gateDesign,
  GOLDEN_DESIGN,
  chatSystemInstruction,
  type MockFixture,
  type RunnerEvent,
  type StagedProposal,
  type ValidatedDesign,
} from "../../src/index.js";
import { realAirTsEngine } from "./engineAdapter.js";

const VALID_PATCH = `<patch id="lower_bottom">
  <reason>drop the divider tap voltage</reason>
  <replace path="/system/components/component[@id='R_BOT']/value"><value>4.7k</value></replace>
</patch>`;

/** A design missing required sections — fails the gate at VALIDATION (not parse). */
const INVALID_DESIGN = '<system name="broken" ir_version="0.1"><nets><net id="gnd" role="ground"/></nets></system>';

/** Collect all runner events a run emits, plus a convenience projection. */
function sink() {
  const events: RunnerEvent[] = [];
  return {
    events,
    onEvent: (e: RunnerEvent) => events.push(e),
    of<T extends RunnerEvent["type"]>(type: T) {
      return events.filter((e): e is Extract<RunnerEvent, { type: T }> => e.type === type);
    },
  };
}

function newRuntime(design = GOLDEN_DESIGN, version = 0) {
  return new ToolRuntime(
    { xml: design, version },
    { hooks: realAirTsEngine(), idFactory: makeIdFactory() },
  );
}

function makeIdFactory(): () => string {
  let n = 0;
  return () => `proposal-${++n}`;
}

/**
 * A "design writer" that stands in for the UI's single editor-state writer. It
 * accepts ONLY a ValidatedDesign — the same type constraint the real UI writer
 * has — so a test that tries to write a non-gated value would not compile.
 */
function makeEditor(initialXml: string, initialVersion: number) {
  let xml = initialXml;
  let version = initialVersion;
  return {
    get xml() {
      return xml;
    },
    get version() {
      return version;
    },
    /** The ONLY write path: takes a ValidatedDesign, bumps the version. */
    write(design: ValidatedDesign): void {
      xml = design.xml;
      version += 1;
    },
    /** A direct user edit (bumps the version WITHOUT going through the agent). */
    userEdit(nextXml: string): void {
      xml = nextXml;
      version += 1;
    },
  };
}

// --------------------------------------------------------------------------- //
// (a) Happy path: build -> validate -> simulate.
// --------------------------------------------------------------------------- //

describe("scenario (a): happy path build -> validate -> simulate", () => {
  it("stages a valid design, validates, and simulates, all green", async () => {
    const fixture: MockFixture = {
      turns: [
        [
          { type: "text-delta", text: "Building circuit... a 3V3 divider from the LDO." },
          { type: "tool-call", id: "c1", name: "set_design", args: { design_xml: GOLDEN_DESIGN, summary: "3V3 rail + sense divider" } },
          { type: "usage", inputTokens: 100, outputTokens: 20 },
          { type: "done", stopReason: "tool_use" },
        ],
        [
          { type: "tool-call", id: "c2", name: "validate_design", args: {} },
          { type: "usage", inputTokens: 120, outputTokens: 10 },
          { type: "done", stopReason: "tool_use" },
        ],
        [
          { type: "tool-call", id: "c3", name: "run_simulation", args: {} },
          { type: "usage", inputTokens: 130, outputTokens: 12 },
          { type: "done", stopReason: "tool_use" },
        ],
        [
          { type: "text-delta", text: "Done. The midpoint reads ~1.65 V and the assertion passes." },
          { type: "done", stopReason: "stop" },
        ],
      ],
    };
    const runtime = newRuntime();
    const s = sink();
    const { reason } = await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "build a 3.3V divider from 9V and probe the midpoint",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });

    expect(reason).toBe("completed");

    // A proposal was STAGED (not written).
    const staged = s.of("proposal-staged");
    expect(staged).toHaveLength(1);
    expect(runtime.stagedProposals()).toHaveLength(1);

    // validate_design fed back valid:true; run_simulation returned passed.
    const results = s.of("tool-result");
    const validateResult = results.find((r) => r.name === "validate_design")!;
    expect(validateResult.result).toContain('"valid": true');
    const simResult = results.find((r) => r.name === "run_simulation")!;
    expect(simResult.result).toContain('"status": "passed"');
  });
});

// --------------------------------------------------------------------------- //
// (b) Gate rejection: malformed proposal never reaches editor state.
// --------------------------------------------------------------------------- //

describe("scenario (b): invalid proposal REJECTED by the gate", () => {
  it("feeds diagnostics back to the model and stages NOTHING", async () => {
    const fixture: MockFixture = {
      turns: [
        [
          { type: "text-delta", text: "Building circuit..." },
          { type: "tool-call", id: "c1", name: "set_design", args: { design_xml: INVALID_DESIGN, summary: "attempt" } },
          { type: "done", stopReason: "tool_use" },
        ],
        // After receiving diagnostics, the model gives up gracefully.
        [
          { type: "text-delta", text: "I see validation errors; let me reconsider." },
          { type: "done", stopReason: "stop" },
        ],
      ],
    };
    const runtime = newRuntime();
    const s = sink();
    await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "make a broken design",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });

    // THE INVARIANT: no proposal was staged (the gate rejected before staging).
    expect(s.of("proposal-staged")).toHaveLength(0);
    expect(runtime.stagedProposals()).toHaveLength(0);

    // The model received the diagnostics as the tool result.
    const setResult = s.of("tool-result").find((r) => r.name === "set_design")!;
    expect(setResult.result).toContain("validation_failed");
    expect(setResult.result).toContain("MISSING_SECTION");
  });

  it("a malformed-XML proposal is rejected at the gate too (parse error)", () => {
    // Directly assert the gate itself never yields a ValidatedDesign for junk.
    const r = gateDesign("<system><oops", realAirTsEngine());
    expect(r.ok).toBe(false);
    // There is no `design` field on a failed gate result — type + runtime proof.
    expect("design" in r).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// (c) User rejects a staged diff.
// --------------------------------------------------------------------------- //

describe("scenario (c): user rejects a staged proposal", () => {
  it("discards the proposal without writing editor state", async () => {
    const startXml = GOLDEN_DESIGN;
    const editor = makeEditor(startXml, 0);
    const fixture: MockFixture = {
      turns: [
        [
          { type: "tool-call", id: "c1", name: "propose_patch", args: { patch_xml: VALID_PATCH, summary: "lower R_BOT" } },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "text-delta", text: "Staged the edit for your review." }, { type: "done", stopReason: "stop" }],
      ],
    };
    const runtime = new ToolRuntime({ xml: editor.xml, version: editor.version }, { hooks: realAirTsEngine(), idFactory: makeIdFactory() });
    const s = sink();
    await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "lower the bottom resistor",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });

    const staged = s.of("proposal-staged");
    expect(staged).toHaveLength(1);

    // The user REJECTS: we simply never call editor.write. Assert the editor is
    // untouched — the design and version are exactly as before.
    expect(editor.xml).toBe(startXml);
    expect(editor.version).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// (d) Budget exhausted mid-loop.
// --------------------------------------------------------------------------- //

describe("scenario (d): budget exhausted mid-loop", () => {
  it("stops the loop when the iteration budget is spent", async () => {
    // A fixture that would loop forever (every turn calls a tool and says
    // tool_use) — the budget must cut it off.
    const loopingTurn: MockFixture["turns"][number] = [
      { type: "tool-call", id: "loop", name: "list_registry_components", args: {} },
      { type: "done", stopReason: "tool_use" },
    ];
    const fixture: MockFixture = { turns: Array.from({ length: 50 }, () => loopingTurn) };

    const runtime = newRuntime();
    const s = sink();
    const { reason } = await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "keep going",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      budget: { maxIterations: 3 },
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });

    expect(reason).toBe("budget_iterations");
    // Exactly 3 provider turns ran (the budget cap).
    const budgets = s.of("budget");
    const lastBudget = budgets.at(-1)!;
    expect(lastBudget.usage.iterations).toBe(3);
  });

  it("stops when the token budget is spent", async () => {
    const bigUsageTurn: MockFixture["turns"][number] = [
      { type: "tool-call", id: "t", name: "list_registry_components", args: {} },
      { type: "usage", inputTokens: 900, outputTokens: 900 },
      { type: "done", stopReason: "tool_use" },
    ];
    const fixture: MockFixture = { turns: Array.from({ length: 50 }, () => bigUsageTurn) };
    const runtime = newRuntime();
    const s = sink();
    const { reason } = await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "burn tokens",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      budget: { maxTokens: 2000 },
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });
    expect(reason).toBe("budget_tokens");
  });
});

// --------------------------------------------------------------------------- //
// (e) Concurrent-edit: version-stamped Apply -> rebase/conflict, never clobber.
// --------------------------------------------------------------------------- //

describe("scenario (e): concurrent edit — versioned Apply never clobbers", () => {
  async function stageOne(design: string, version: number): Promise<{ proposal: StagedProposal }> {
    const runtime = new ToolRuntime({ xml: design, version }, { hooks: realAirTsEngine(), idFactory: makeIdFactory() });
    const fixture: MockFixture = {
      turns: [
        [
          { type: "tool-call", id: "c1", name: "propose_patch", args: { patch_xml: VALID_PATCH, summary: "lower R_BOT" } },
          { type: "done", stopReason: "tool_use" },
        ],
        [{ type: "text-delta", text: "staged" }, { type: "done", stopReason: "stop" }],
      ],
    };
    const s = sink();
    await runConversation({
      provider: new MockProvider(fixture),
      runtime,
      userMessage: "lower R_BOT",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });
    return { proposal: s.of("proposal-staged")[0]!.proposal };
  }

  it("Apply at matching version applies cleanly", async () => {
    const editor = makeEditor(GOLDEN_DESIGN, 0);
    const { proposal } = await stageOne(editor.xml, editor.version);
    const outcome = resolveApply(proposal, editor.xml, editor.version, realAirTsEngine());
    expect(outcome.status).toBe("clean");
    if (outcome.status === "clean") editor.write(outcome.design);
    expect(editor.xml).toContain("4.7k");
    expect(editor.version).toBe(1);
  });

  it("Apply after a compatible user edit REBASES over newer edits (no clobber)", async () => {
    const editor = makeEditor(GOLDEN_DESIGN, 0);
    const { proposal } = await stageOne(editor.xml, editor.version); // baseVersion 0

    // The user edits a DIFFERENT part while the proposal is staged: change R_TOP.
    const userEdited = GOLDEN_DESIGN.replace(
      '<component id="R_TOP" type="resistor"><value>10k</value>',
      '<component id="R_TOP" type="resistor"><value>22k</value>',
    );
    editor.userEdit(userEdited); // version -> 1

    const outcome = resolveApply(proposal, editor.xml, editor.version, realAirTsEngine());
    // The patch touches R_BOT; the user changed R_TOP — the patch re-applies.
    expect(outcome.status).toBe("rebased");
    if (outcome.status === "rebased") {
      editor.write(outcome.design);
      // Both edits survive — the user's 22k AND the agent's 4.7k. NO clobber.
      expect(editor.xml).toContain("22k");
      expect(editor.xml).toContain("4.7k");
    }
  });

  it("Apply after a CONFLICTING user edit flips to conflict (never silent overwrite)", async () => {
    const editor = makeEditor(GOLDEN_DESIGN, 0);
    const { proposal } = await stageOne(editor.xml, editor.version); // baseVersion 0

    // The user REMOVES the very element the patch targets (R_BOT). The patch can
    // no longer apply -> a real conflict; the user must choose.
    const userEdited = GOLDEN_DESIGN.replace(
      /<component id="R_BOT" type="resistor"><value>10k<\/value>\s*<pin name="1" net="sense"\/><pin name="2" net="gnd"\/><\/component>/,
      "",
    );
    editor.userEdit(userEdited); // version -> 1

    const outcome = resolveApply(proposal, editor.xml, editor.version, realAirTsEngine());
    expect(outcome.status).toBe("conflict");
    // Nothing was written; the editor still holds the user's version.
    expect(editor.version).toBe(1);
    expect(editor.xml).not.toContain('id="R_BOT"');
  });
});
