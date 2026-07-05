/**
 * The build loop (issue #107 deliverable 1) — the generative counterpart to
 * #19's repair loop. It seeds a minimal shell design, hands the agent the spec's
 * natural-language prompt as the task in BUILDING mode, and drives the
 * conversation through the #18 ToolRuntime until the design scores as built, the
 * turn budget is spent, or a stop condition fires.
 *
 * REUSE, NOT FORK. This loop reuses the #18 machinery directly:
 *   - `runConversation` drives each iteration's provider turn(s) through the
 *     ToolRuntime — the agent uses set_design (GATED via #96), validate_design,
 *     run_simulation, list_registry_components, etc. The #101 multi-tool-call fix
 *     lives in that runner, so it is inherited unchanged.
 *   - Every design write is a `ValidatedDesign` from the #96 gate: a staged
 *     proposal's `validated.xml` is the ONLY thing that becomes the current
 *     design. There is no bypass — the build is only ever a gated design.
 *
 * STOP CONDITIONS (mirroring #19's distinct outcomes):
 *   - built           the current design passed ALL its criteria (objective
 *                     scorer) within budget — the single success outcome.
 *   - max_turns       the turn budget was reached with the design not yet built.
 *   - no_progress     an iteration staged nothing new AND the design did not
 *                     change — the loop is spinning (semantic: XML unchanged).
 *   - no_build        no proposal was ever staged (the model never produced a
 *                     gate-passing design) — a distinct honest not-built outcome.
 *   - provider_error  the provider stream errored (auth/quota/network/model) —
 *                     DISTINCT from the model failing to build.
 *   - scorer_error    the objective scorer's toolchain failed (missing ngspice /
 *                     python) — NOT an agent failure; surfaced so a broken
 *                     scorer is never mislabeled as a `0`.
 *   - stopped / error the caller's Stop, or an unexpected failure.
 *
 * FRESH CONTEXT PER ITERATION (amendment 1 discipline): each iteration rebuilds
 * its user message from the NL prompt + current design + compact prior-attempt
 * history, and runs `runConversation` with history:[] — no growing transcript.
 */

import type { AgentProvider, Msg } from "../../src/index.js";
import type { EngineHooks } from "../../src/index.js";
import type { StagedProposal } from "../../src/index.js";
import {
  ToolRuntime,
  runConversation,
  chatSystemInstruction,
  DEFAULT_TOKEN_BUDGET,
  type BudgetLimits,
  type RunnerEvent,
  type RunEndReason,
} from "../../src/index.js";
import type { BuildSpec } from "./specs.js";
import type { BuildScore, ScoreFn } from "./scorer.js";
import {
  assembleBuildContext,
  DEFAULT_BUILD_CONTEXT_CHAR_BUDGET,
  type BuildAttemptSummary,
} from "./context.js";

/** Why the build loop stopped — each a DISTINCT, honest outcome. */
export type BuildStopReason =
  | "built"
  | "max_turns"
  | "no_progress"
  | "no_build"
  | "provider_error"
  | "scorer_error"
  | "token_cap"
  | "stopped"
  | "error";

/** True for the single SUCCESS outcome. */
export function isBuilt(reason: BuildStopReason): boolean {
  return reason === "built";
}

/** The minimal, valid shell the agent starts from (never scored; just a seed). */
export const BUILD_SHELL_XML = `<system name="build_shell" ir_version="0.1">
  <metadata>
    <title>Empty build shell</title>
    <description>Minimal valid starting point for a build-benchmark task; the agent replaces it via set_design.</description>
    <author>build-bench</author>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
  </nets>
  <components/>
  <tests/>
  <simulation_profiles/>
</system>`;

export interface BuildLoopOptions {
  /** The spec whose NL prompt drives the build + whose criteria are scored. */
  spec: BuildSpec;
  /** The provider driving each iteration (mock in CI, real BYOK live). */
  provider: AgentProvider;
  /** The engine seam (real air-ts gate + a sim stub for the tool loop). */
  hooks: EngineHooks;
  /**
   * The objective scorer (default: the Python subprocess). Injected so the CI
   * mock test scores deterministically offline while the CLI uses real ngspice.
   */
  scoreFn: ScoreFn;
  /** Turn budget override (defaults to the spec's turn_budget). */
  turnBudget?: number;
  /** Max tokens per provider turn. */
  maxTokensPerTurn?: number;
  /** Hard per-iteration context char budget (amendment 1). */
  contextCharBudget?: number;
  /** Model id for provider messages. */
  modelId?: string;
  /** Stop signal. */
  signal?: AbortSignal;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Deterministic proposal ids (tests). */
  idFactory?: () => string;
  /** Observe live progress. */
  onEvent?: (event: BuildLoopEvent) => void;
  /**
   * HARD per-spec cumulative token cap. If cumulative tokens exceed this after
   * an iteration, the loop stops with `token_cap`. Belt-and-suspenders on top of
   * the per-iteration BudgetLimits (BUILD_ITER_BUDGET) — this is what guarantees
   * a predictable live spend across the outer build iterations.
   */
  perSpecTokenCap?: number;
}

/** Live events for progress reporting. */
export type BuildLoopEvent =
  | { type: "iteration-start"; index: number }
  | { type: "tool-call"; index: number; name: string }
  | { type: "usage"; index: number; inputTokens: number; outputTokens: number }
  | { type: "proposal-staged"; index: number; proposal: StagedProposal }
  | { type: "scored"; index: number; score: BuildScore }
  | { type: "iteration-end"; index: number; entry: IterationLogEntry }
  | { type: "done"; result: BuildResult };

/** One compact per-iteration log entry — enough to reason about a failure. */
export interface IterationLogEntry {
  readonly index: number;
  /** Tool names called this iteration, in order (compact — no args). */
  readonly toolCalls: string[];
  /** Tokens consumed this iteration. */
  readonly tokens: number;
  /** Whether the agent staged a gated design this iteration. */
  readonly staged: boolean;
  /** The staged design's one-line summary (empty if nothing staged). */
  readonly stageSummary: string;
  /** Whether the staged design was DIFFERENT from the prior current design. */
  readonly progressed: boolean;
  /** The conversation runner's end reason for this iteration. */
  readonly conversationReason: string;
  /** Scorer verdict (null if nothing was staged this iteration). */
  readonly scoreSummary: string | null;
}

/** The result of a build run — what the runner scores + reports. */
export interface BuildResult {
  readonly reason: BuildStopReason;
  /** The final (gated) design XML the agent produced, or the shell if none. */
  readonly finalXml: string;
  /** The scorer's verdict on the final design (null if never scored). */
  readonly score: BuildScore | null;
  /** How many iterations ran. */
  readonly iterations: number;
  /** Total tokens across all iterations. */
  readonly totalTokens: number;
  /** Per-iteration compact log (for the results JSON's `log` field). */
  readonly log: IterationLogEntry[];
  /** A one-line human explanation. */
  readonly message: string;
}

/**
 * PER-ITERATION conversation-runner budget cap. HARD-BOUND explicitly here,
 * OVERRIDING the runner's default (12 turns × 200_000 tokens) — the runner default
 * is sized for a UI chat, not a benchmark, and the pre-cap live smoke burned
 * 267k tokens on a single spec because ONE build iteration is one runConversation
 * which can spend the full default before this loop's `no_progress` fires.
 *
 * The cap is per BUILD-LOOP iteration; multiplied by `turnBudget` (default 4)
 * this is the per-spec worst case. 4 conv turns × 24k tokens × 4 build iters =
 * 384k tokens absolute ceiling, ~$0.80/spec at Sonnet 5 rates.
 */
export const BUILD_ITER_BUDGET: BudgetLimits = {
  maxIterations: 4,
  maxTokens: 24_000,
  maxWallMs: 60_000,
};

/**
 * Run the build loop to a terminal outcome. Pure over its inputs + the injected
 * provider/hooks/scorer. The only design mutations happen through the gate (a
 * staged `ValidatedDesign`); the build is only ever a gated design.
 */
export async function runBuildLoop(opts: BuildLoopOptions): Promise<BuildResult> {
  const turnBudget = opts.turnBudget ?? opts.spec.turn_budget ?? 4;
  const contextBudget = opts.contextCharBudget ?? DEFAULT_BUILD_CONTEXT_CHAR_BUDGET;
  const maxTokensPerTurn = opts.maxTokensPerTurn ?? DEFAULT_TOKEN_BUDGET;
  const signal = opts.signal ?? new AbortController().signal;
  const emit = opts.onEvent ?? (() => {});
  const system = chatSystemInstruction();

  let currentXml = BUILD_SHELL_XML;
  let isShell = true;
  let stagedEver = false;
  let lastScore: BuildScore | null = null;
  let totalTokens = 0;
  let iterations = 0;
  const history: BuildAttemptSummary[] = [];
  const log: IterationLogEntry[] = [];

  const finish = (reason: BuildStopReason): BuildResult => {
    const result: BuildResult = {
      reason,
      finalXml: currentXml,
      score: lastScore,
      iterations,
      totalTokens,
      log,
      message: outcomeMessage(reason, iterations),
    };
    emit({ type: "done", result });
    return result;
  };

  for (let index = 0; index < turnBudget; index++) {
    if (signal.aborted) return finish("stopped");
    iterations = index + 1;
    emit({ type: "iteration-start", index });

    // --- Assemble the FRESH per-iteration build context. ---------------- //
    const userMessage = assembleBuildContext(
      {
        prompt: opts.spec.prompt,
        designXml: currentXml,
        isShell,
        history,
        iteration: index,
        turnBudget,
      },
      contextBudget,
    );

    // --- Drive ONE gate-enforced conversation for this iteration. ------- //
    const runtime = new ToolRuntime(
      { xml: currentXml, version: index },
      {
        hooks: opts.hooks,
        ...(opts.idFactory ? { idFactory: opts.idFactory } : {}),
      },
    );

    let staged: StagedProposal | null = null;
    let iterationTokens = 0;
    const iterToolCalls: string[] = [];
    const onConvEvent = (ev: RunnerEvent) => {
      switch (ev.type) {
        case "tool-call":
          iterToolCalls.push(ev.name);
          emit({ type: "tool-call", index, name: ev.name });
          break;
        case "proposal-staged":
          // LAST staged proposal wins: within one iteration the agent may stage,
          // validate, then re-stage a corrected design; the final gated design is
          // the candidate build for this iteration.
          staged = ev.proposal;
          break;
        case "usage":
          iterationTokens += ev.inputTokens + ev.outputTokens;
          emit({ type: "usage", index, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
          break;
        default:
          break;
      }
    };

    let convReason: RunEndReason;
    try {
      const convResult = await runConversation({
        provider: opts.provider,
        runtime,
        userMessage,
        history: [] as Msg[], // FRESH CONTEXT: no cross-iteration accumulation.
        system,
        maxTokensPerTurn,
        // TIGHT per-iteration cap — override the runner's default (12 turns × 200k
        // tokens). The pre-cap smoke burned 267k tokens on ONE spec because this
        // was uncapped; multiplied across build iterations that could exceed
        // 600k. The cap makes a per-spec worst case predictable + affordable.
        budget: BUILD_ITER_BUDGET,
        signal,
        onEvent: onConvEvent,
        ...(opts.modelId ? { modelId: opts.modelId } : {}),
        ...(opts.now ? { now: opts.now } : {}),
      });
      convReason = convResult.reason;
    } catch (err) {
      if (signal.aborted) return finish("stopped");
      void err;
      const entry: IterationLogEntry = {
        index, toolCalls: iterToolCalls, tokens: iterationTokens,
        staged: false, stageSummary: "", progressed: false,
        conversationReason: "error", scoreSummary: null,
      };
      log.push(entry);
      emit({ type: "iteration-end", index, entry });
      return finish("error");
    }
    totalTokens += iterationTokens;

    // Provider stream error that staged nothing is DISTINCT.
    if (!staged && convReason === "provider_error") {
      const entry: IterationLogEntry = {
        index, toolCalls: iterToolCalls, tokens: iterationTokens,
        staged: false, stageSummary: "", progressed: false,
        conversationReason: convReason, scoreSummary: null,
      };
      log.push(entry);
      emit({ type: "iteration-end", index, entry });
      return finish("provider_error");
    }
    if (convReason === "aborted" || signal.aborted) {
      const entry: IterationLogEntry = {
        index, toolCalls: iterToolCalls, tokens: iterationTokens,
        staged: !!staged, stageSummary: staged ? (staged as StagedProposal).summary : "",
        progressed: false, conversationReason: convReason, scoreSummary: null,
      };
      log.push(entry);
      emit({ type: "iteration-end", index, entry });
      return finish("stopped");
    }

    // --- Adopt the staged (gated) design, if any, and detect no-progress. //
    if (staged) {
      const proposal: StagedProposal = staged;
      const newXml = proposal.validated.xml;
      const progressed = newXml !== currentXml;
      currentXml = newXml; // the gated, canonical design — the ONLY write path.
      isShell = false;
      stagedEver = true;
      emit({ type: "proposal-staged", index, proposal });

      // --- Score the current (gated) design objectively. ----------------- //
      // HARDENING (per coordinator): a scorer subprocess failure should not
      // become a scorer_error black hole. The scorer is designed to catch
      // Python-side exceptions and return a scored non-build (failed_criterion:
      // "scorer_exception"). If the *subprocess itself* fails (spawn error, no
      // output, timeout), synthesize a scored non-build here with the reason
      // rather than throwing — the case lands in the results with a diagnostic,
      // not lost as "scorer_error" (which the coordinator called out as a black
      // hole).
      let score: BuildScore;
      try {
        score = await opts.scoreFn(currentXml, opts.spec.criteria);
      } catch (err) {
        const detail = (err as Error).message.slice(0, 300);
        score = {
          built: false,
          failed_criterion: "scorer_subprocess",
          detail: `scorer subprocess failed: ${detail}`,
          criteria: {},
          sim_backend: null,
          sim_value: null,
        };
      }
      lastScore = score;
      emit({ type: "scored", index, score });

      const scoreSummary = score.built
        ? "built"
        : `not-built failed=${score.failed_criterion ?? "?"}: ${score.detail.slice(0, 160)}`;

      const entry: IterationLogEntry = {
        index, toolCalls: iterToolCalls, tokens: iterationTokens,
        staged: true, stageSummary: proposal.summary, progressed,
        conversationReason: convReason, scoreSummary,
      };
      log.push(entry);
      emit({ type: "iteration-end", index, entry });

      if (score.built) return finish("built");

      history.push({
        iteration: index,
        summary: proposal.summary,
        progressed,
        note: score.failed_criterion
          ? `failed ${score.failed_criterion}: ${score.detail.slice(0, 120)}`
          : "not built",
      });

      // No-progress: the design did not change this iteration (the model re-
      // staged the same design or a validation-equivalent one). Spinning — stop.
      if (!progressed) return finish("no_progress");
      // Hard per-spec token cap — belt-and-suspenders on the per-iteration cap.
      if (opts.perSpecTokenCap !== undefined && totalTokens >= opts.perSpecTokenCap) {
        return finish("token_cap");
      }
    } else {
      // No proposal this iteration.
      history.push({
        iteration: index,
        summary: "(no design staged this iteration)",
        progressed: false,
        note: convReason === "completed" ? "model produced no set_design" : convReason,
      });
      const entry: IterationLogEntry = {
        index, toolCalls: iterToolCalls, tokens: iterationTokens,
        staged: false, stageSummary: "", progressed: false,
        conversationReason: convReason, scoreSummary: null,
      };
      log.push(entry);
      emit({ type: "iteration-end", index, entry });
      if (!stagedEver) return finish("no_build");
    }
  }

  return finish("max_turns");
}

function outcomeMessage(reason: BuildStopReason, iterationCount: number): string {
  switch (reason) {
    case "built":
      return `Built and passed all criteria after ${iterationCount} iteration(s).`;
    case "max_turns":
      return `Did not satisfy all criteria within ${iterationCount} turn(s).`;
    case "no_progress":
      return `Stopped: the design did not change (no progress) after ${iterationCount} iteration(s).`;
    case "no_build":
      return `Stopped: the model staged no design that passed the gate after ${iterationCount} iteration(s).`;
    case "provider_error":
      return `Stopped: the provider errored (auth / quota / network) after ${iterationCount} iteration(s).`;
    case "scorer_error":
      return `Stopped: the objective scorer toolchain failed after ${iterationCount} iteration(s) (not an agent failure).`;
    case "token_cap":
      return `Stopped: the per-spec token cap was hit after ${iterationCount} iteration(s) (belt-and-suspenders spend guard).`;
    case "stopped":
      return `Stopped by the user after ${iterationCount} iteration(s).`;
    case "error":
      return `Stopped: an unexpected error occurred after ${iterationCount} iteration(s).`;
  }
}
