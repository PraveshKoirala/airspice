/**
 * The autonomous repair loop (issue #19) — the flagship differentiator, run
 * entirely client-side: point the agent at a broken design and it iterates
 * simulate → diagnose → patch → re-simulate until the constraints pass, with
 * EVERY proposed fix forced through the #18 deterministic gate.
 *
 * This is the browser PORT of the Python convergence-aware loop
 * (`agent.py:run_autonomous_repair` + `repair.py:build_repair_context` +
 * `repair_session.py`). The Python loop's shape is preserved: per-iteration
 * repair-context assembly, an iteration policy with distinct stop conditions,
 * and convergence awareness. The browser adaptations are the ones #18 already
 * pinned down — the model is driven through the tool runtime (proposals STAGED
 * behind the gate, never a direct write), and the engine is the injected
 * EngineHooks seam (real air-ts + the local sim pipeline in the UI; real air-ts
 * + a deterministic simulate in CI).
 *
 * BINDING POST-AUDIT AMENDMENTS (issue #19 body):
 *
 *   1. FRESH CONTEXT PER ITERATION. The loop does NOT accumulate a growing
 *      transcript. Each iteration rebuilds its context from scratch: the repair
 *      system prompt + the CURRENT design + a freshly assembled repair-context
 *      (failing assertions, diagnostics, decimated netlist/waveform excerpts) +
 *      a COMPACT structured history of prior attempts (patch summary + outcome
 *      per iteration, NOT full patches or full reports). This mirrors the Python
 *      loop's repair-context design and bounds token growth BY CONSTRUCTION — the
 *      per-iteration context is assembled under a hard char budget
 *      (`contextCharBudget`); assembling beyond it is a bug, not a truncation
 *      event, so the loop THROWS rather than silently clip (`assertBudget`).
 *      Each iteration runs as an independent `runConversation` with history:[]
 *      — there is no cross-iteration message list to grow.
 *
 *   2. NO-PROGRESS IS SEMANTIC. Convergence's no-progress detector compares the
 *      SEMANTIC diagnostic signature — the sorted diagnostic-code SET plus the
 *      assertion pass/fail VECTOR — across two consecutive rounds, NOT the
 *      whole-report string (floats + timestamps differ run to run). See
 *      `diagnosticSignature` / `signaturesEqual`.
 *
 *   3. CONVERGENCE AWARENESS (#45). A simulation that SUCCEEDED on the
 *      convergence-ladder rung >= 2 is NOT a design defect — the loop must not
 *      "repair" a design that already passes, so a passing sim ends the loop
 *      `fixed` regardless of the rung it converged on. A TERMINAL convergence
 *      failure (`convergence.terminal`) directs diagnosis toward TOPOLOGY
 *      (floating nodes / missing ground) BEFORE values — the assembled context
 *      surfaces the terminal note first (`topologyFirstHint`).
 */

import type { AgentProvider, Msg } from "../types.js";
import type { EngineHooks, GateDiagnostic, SimulationReportLike } from "../tools/engine.js";
import type { ValidatedDesign } from "../tools/validated.js";
import type { StagedProposal } from "../tools/staging.js";
import { ToolRuntime } from "../tools/runtime.js";
import { runConversation, type RunnerEvent } from "../tools/conversation.js";
import { repairSystemInstruction } from "../tools/prompts.js";
import { DEFAULT_TOKEN_BUDGET } from "../models.js";
import {
  assembleRepairContext,
  signaturesEqual,
  evaluateDesign,
  type DesignEvaluation,
  type DiagnosticSignature,
} from "./context.js";

// --------------------------------------------------------------------------- //
// Outcomes — each stop condition is a DISTINCT, user-visible reason.
// --------------------------------------------------------------------------- //

/**
 * Why the repair loop stopped. Each is rendered DISTINCTLY in the UI (issue #19
 * acceptance criterion). PORT of the Python loop's distinct `message` cases:
 *   - fixed              all constraints pass (validation clean + sim passed).
 *   - max_iterations     the iteration cap was reached with issues remaining.
 *   - no_progress        two consecutive rounds produced the SAME semantic
 *                        diagnostic signature — the loop is spinning.
 *   - budget_exhausted   a token / wall-time budget was spent (code-enforced).
 *   - no_fix_proposed    an iteration produced no staged (gated) proposal — the
 *                        model could not offer a fix that passes the gate.
 *   - provider_error     the provider stream errored (auth / quota / network /
 *                        model) — DISTINCT from the model failing to fix, so a
 *                        rate-limited case is not mislabeled as a bad model.
 *   - stopped            the caller's Stop signal fired.
 *   - error              an unexpected engine/provider failure.
 */
export type RepairStopReason =
  | "fixed"
  | "max_iterations"
  | "no_progress"
  | "budget_exhausted"
  | "no_fix_proposed"
  | "provider_error"
  | "stopped"
  | "error";

/** True for the single SUCCESS outcome; every other reason is not-fixed. */
export function isFixed(reason: RepairStopReason): boolean {
  return reason === "fixed";
}

/** A patch applied during one iteration, recorded as an UNDOABLE step (#19). */
export interface AppliedStep {
  /** The staged (gated) proposal that was applied. */
  readonly proposal: StagedProposal;
  /** The gated design this step produced (the undo TARGET is the prior xml). */
  readonly design: ValidatedDesign;
  /** The design XML BEFORE this step — undo restores exactly this. */
  readonly previousXml: string;
  /** The model's one-line reasoning summary for this patch. */
  readonly reasoningSummary: string;
}

/** One iteration's observable record — the UI timeline row (#19 deliverable 2). */
export interface RepairIteration {
  /** 0-based iteration index. */
  readonly index: number;
  /** The design XML this iteration DIAGNOSED (before any patch this round). */
  readonly designXmlBefore: string;
  /** The evaluation (diagnostics + sim report + signature) it diagnosed from. */
  readonly evaluation: DesignEvaluation;
  /** The model's diagnosis / patch prose (assistant text this round). */
  readonly diagnosis: string;
  /** The patch applied this round, if any (gated). Undoable. */
  readonly appliedStep?: AppliedStep;
  /** Runner end reason for this round's conversation (budget/stop/etc.). */
  readonly conversationReason: string;
  /** Tokens consumed this round (input+output), for the bench scorer. */
  readonly tokens: number;
}

/** The full result of a repair run — what the UI + the benchmark consume. */
export interface RepairResult {
  readonly reason: RepairStopReason;
  /** The final design XML (patched if any steps applied; else the original). */
  readonly finalXml: string;
  /** Every iteration's record, in order (the UI timeline). */
  readonly iterations: RepairIteration[];
  /** The applied, undoable steps in order (the undo stack). */
  readonly appliedSteps: AppliedStep[];
  /** Total tokens across all iterations (bench scorer). */
  readonly totalTokens: number;
  /** A human, user-visible one-line explanation of the outcome. */
  readonly message: string;
}

// --------------------------------------------------------------------------- //
// Options.
// --------------------------------------------------------------------------- //

export interface RepairLoopOptions {
  /** The broken design to repair (AIR XML). */
  design: string;
  /** The provider driving each iteration (mock in CI, real BYOK in the UI). */
  provider: AgentProvider;
  /** The engine seam (real air-ts gate + sim; injected — never forked). */
  hooks: EngineHooks;
  /** Max iterations before giving up. PORT default: 5 (issue #19). */
  maxIterations?: number;
  /** Max tokens per provider turn (the settings token budget). */
  maxTokensPerTurn?: number;
  /**
   * Hard per-iteration context CHAR budget (amendment 1). Assembling a context
   * beyond this THROWS — a growing context is a bug, not a truncation event.
   * Default sized generously for design + diagnostics + report excerpt + compact
   * history, but bounded so token growth is impossible by construction.
   */
  contextCharBudget?: number;
  /** Model id for provider/ladder messages. */
  modelId?: string;
  /** Stop button: aborts the in-flight iteration's provider + simulation. */
  signal?: AbortSignal;
  /** Injectable clock for the per-run wall-time budget (tests). */
  now?: () => number;
  /** Observe live progress (UI timeline + status). */
  onEvent?: (event: RepairLoopEvent) => void;
  /** Deterministic proposal ids for tests. */
  idFactory?: () => string;
}

/** Live events the loop emits so the UI renders the timeline + status. */
export type RepairLoopEvent =
  | { type: "iteration-start"; index: number; evaluation: DesignEvaluation }
  | { type: "diagnosis"; index: number; text: string }
  | { type: "patch-applied"; index: number; step: AppliedStep }
  | { type: "iteration-end"; index: number; iteration: RepairIteration }
  | { type: "done"; result: RepairResult };

/** Default max iterations — the issue's ported default. */
export const DEFAULT_MAX_ITERATIONS = 5;
/** Default per-iteration context char budget (amendment 1's hard bound). */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 24_000;

// --------------------------------------------------------------------------- //
// The loop.
// --------------------------------------------------------------------------- //

/**
 * Run the autonomous repair loop to a terminal outcome. Pure over its inputs +
 * the injected provider/hooks/clock — the ONLY design mutations happen through
 * `runtime` (the gate) and are recorded as undoable `AppliedStep`s.
 *
 * The loop NEVER writes editor state itself: it returns the applied steps + the
 * final gated XML; the UI's single writer (`applyValidated`) is what persists a
 * chosen result. (In the UI, the repair panel applies each step live via that
 * writer; in CI the benchmark reads `finalXml`.)
 */
export async function runRepairLoop(opts: RepairLoopOptions): Promise<RepairResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const contextBudget = opts.contextCharBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  const maxTokensPerTurn = opts.maxTokensPerTurn ?? DEFAULT_TOKEN_BUDGET;
  const signal = opts.signal ?? new AbortController().signal;
  const emit = opts.onEvent ?? (() => {});
  const system = repairSystemInstruction();

  let currentXml = opts.design;
  const iterations: RepairIteration[] = [];
  const appliedSteps: AppliedStep[] = [];
  // COMPACT structured history: patch summary + outcome per prior iteration.
  // NOT full patches or full reports (amendment 1). This is what bounds context.
  const history: AttemptSummary[] = [];
  let previousSignature: DiagnosticSignature | null = null;
  let totalTokens = 0;

  const finish = (reason: RepairStopReason): RepairResult => {
    const result: RepairResult = {
      reason,
      finalXml: currentXml,
      iterations,
      appliedSteps,
      totalTokens,
      message: outcomeMessage(reason, iterations.length),
    };
    emit({ type: "done", result });
    return result;
  };

  for (let index = 0; index < maxIterations; index++) {
    if (signal.aborted) return finish("stopped");

    // --- Evaluate the CURRENT design: validate + simulate. --------------- //
    // A passing evaluation (validation clean AND sim passed) is DONE — including
    // #45's "succeeded on rung >= 2" case: a passing sim is not a defect, so we
    // never "repair" a design that already passes (amendment 3).
    let evaluation: DesignEvaluation;
    try {
      evaluation = await evaluateDesign(currentXml, opts.hooks, signal);
    } catch (err) {
      if (signal.aborted) return finish("stopped");
      void err;
      return finish("error");
    }
    if (evaluation.passes) {
      // The design already passes — nothing to repair. (On iteration 0 this
      // means the input was not actually broken; on later iterations it means
      // the last applied patch fixed it.)
      return finish("fixed");
    }

    emit({ type: "iteration-start", index, evaluation });

    // --- No-progress (SEMANTIC): same signature two consecutive rounds. --- //
    // Compared BEFORE proposing a new fix: if diagnosing the current design
    // yields the identical semantic signature as the previous round diagnosed,
    // the loop is spinning (amendment 2 — code SET + assertion pass/fail vector,
    // never whole-report string equality).
    const signature = evaluation.signature;
    if (previousSignature && signaturesEqual(previousSignature, signature)) {
      return finish("no_progress");
    }

    // --- Assemble FRESH per-iteration context (amendment 1). ------------- //
    // System prompt is stable; the user message is rebuilt from scratch each
    // round: current design + fresh repair-context + COMPACT prior-attempt
    // history. history:[] on the conversation — no growing transcript.
    const userMessage = assembleRepairContext(
      {
        designXml: currentXml,
        evaluation,
        history,
        iteration: index,
        maxIterations,
      },
      contextBudget,
    );

    // --- Drive ONE gate-enforced conversation for this iteration. -------- //
    const runtime = new ToolRuntime(
      { xml: currentXml, version: index },
      {
        hooks: opts.hooks,
        ...(opts.idFactory ? { idFactory: opts.idFactory } : {}),
      },
    );

    let staged: StagedProposal | null = null;
    let diagnosis = "";
    let conversationReason = "";
    let iterationTokens = 0;
    const onConvEvent = (ev: RunnerEvent) => {
      switch (ev.type) {
        case "assistant-text":
          diagnosis += ev.text;
          break;
        case "proposal-staged":
          // FIRST gated proposal wins: the loop applies exactly one patch per
          // iteration, then re-evaluates (the Python loop's one-patch-per-round
          // shape). Every proposal here already passed the gate.
          if (!staged) staged = ev.proposal;
          break;
        case "usage":
          iterationTokens += ev.inputTokens + ev.outputTokens;
          break;
        default:
          break;
      }
    };

    let convResult: Awaited<ReturnType<typeof runConversation>>;
    try {
      convResult = await runConversation({
        provider: opts.provider,
        runtime,
        userMessage,
        history: [] as Msg[], // FRESH CONTEXT: no cross-iteration accumulation.
        system,
        maxTokensPerTurn,
        signal,
        onEvent: onConvEvent,
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
    } catch (err) {
      if (signal.aborted) return finish("stopped");
      void err;
      return finish("error");
    }
    conversationReason = convResult.reason;
    totalTokens += iterationTokens;

    if (diagnosis.trim()) emit({ type: "diagnosis", index, text: diagnosis.trim() });

    // --- Apply the (gated) proposal as an undoable step; re-evaluate. ---- //
    let appliedStep: AppliedStep | undefined;
    if (staged) {
      // TypeScript's control-flow narrowing loses the assignment made inside the
      // event callback above, so re-affirm the non-null proposal explicitly.
      const proposal: StagedProposal = staged;
      const step: AppliedStep = {
        proposal,
        design: proposal.validated,
        previousXml: currentXml,
        reasoningSummary: proposal.summary,
      };
      appliedStep = step;
      appliedSteps.push(step);
      emit({ type: "patch-applied", index, step });
      currentXml = proposal.validated.xml; // the gated, canonical patched XML.
    }

    const iteration: RepairIteration = {
      index,
      designXmlBefore: evaluation.designXml,
      evaluation,
      diagnosis: diagnosis.trim(),
      ...(appliedStep ? { appliedStep } : {}),
      conversationReason,
      tokens: iterationTokens,
    };
    iterations.push(iteration);
    emit({ type: "iteration-end", index, iteration });

    // The conversation's budget is the loop's budget surface (tokens/wall-time
    // are code-enforced there). A budget stop is a DISTINCT outcome.
    if (
      conversationReason === "budget_tokens" ||
      conversationReason === "budget_wall_time" ||
      conversationReason === "budget_iterations"
    ) {
      // If the model DID stage a fix before the budget tripped, let the next
      // loop turn re-evaluate it (progress). Otherwise the budget is the reason.
      if (!appliedStep) return finish("budget_exhausted");
    }
    if (conversationReason === "aborted") return finish("stopped");

    // A provider stream error (auth / quota / network / model) that staged no
    // fix is a DISTINCT outcome — a rate-limited or unreachable provider is not
    // the model "failing to fix". Honest labeling matters for the baseline.
    if (!appliedStep && conversationReason === "provider_error") {
      return finish("provider_error");
    }

    // No gated fix this round AND no budget stop → the model could not offer a
    // fix that passes the gate. That is a distinct, honest not-fixed outcome.
    if (!appliedStep) {
      if (
        conversationReason === "budget_tokens" ||
        conversationReason === "budget_wall_time"
      ) {
        return finish("budget_exhausted");
      }
      return finish("no_fix_proposed");
    }

    // Record this round's signature for the next round's no-progress check, and
    // append the COMPACT attempt summary (bounded history — amendment 1).
    previousSignature = signature;
    history.push({
      iteration: index,
      patchSummary: appliedStep.reasoningSummary,
      resolvedCodes: signature.codes,
    });
  }

  return finish("max_iterations");
}

// --------------------------------------------------------------------------- //
// Compact prior-attempt history (amendment 1: summaries, not full patches).
// --------------------------------------------------------------------------- //

/** One prior attempt, compacted: what was tried + the outcome signature. */
export interface AttemptSummary {
  readonly iteration: number;
  /** The model's one-line patch summary (NOT the full patch XML). */
  readonly patchSummary: string;
  /** The diagnostic codes present when this attempt was diagnosed (compact). */
  readonly resolvedCodes: readonly string[];
}

// --------------------------------------------------------------------------- //
// User-visible messages — one per DISTINCT stop condition (issue #19).
// --------------------------------------------------------------------------- //

function outcomeMessage(reason: RepairStopReason, iterationCount: number): string {
  switch (reason) {
    case "fixed":
      return `All constraints pass after ${iterationCount} iteration(s).`;
    case "max_iterations":
      return `Could not resolve all issues within ${iterationCount} iteration(s).`;
    case "no_progress":
      return `Stopped: the last two rounds produced the same diagnostics (no progress) after ${iterationCount} iteration(s).`;
    case "budget_exhausted":
      return `Stopped: the repair budget (tokens / time) was exhausted after ${iterationCount} iteration(s).`;
    case "no_fix_proposed":
      return `Stopped: no fix passing the validation gate could be produced at iteration ${iterationCount}.`;
    case "provider_error":
      return `Stopped: the provider errored (auth / quota / network) after ${iterationCount} iteration(s).`;
    case "stopped":
      return `Stopped by the user after ${iterationCount} iteration(s).`;
    case "error":
      return `Stopped: an unexpected error occurred after ${iterationCount} iteration(s).`;
  }
}

// Re-export the context helpers the benchmark + tests consume.
export {
  assembleRepairContext,
  diagnosticSignature,
  signaturesEqual,
  evaluateDesign,
} from "./context.js";
export type {
  DesignEvaluation,
  DiagnosticSignature,
  RepairContextInput,
} from "./context.js";

/** Re-export the report/diagnostic types used across the repair surface. */
export type { GateDiagnostic, SimulationReportLike };
