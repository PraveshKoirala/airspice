/**
 * The build-benchmark runner (issue #107 deliverable 3).
 *
 * Runs the build loop over every (or a filtered subset of) build spec and scores
 * each against its criteria with the OBJECTIVE Python scorer. Two modes, mirroring
 * #19's repair runner:
 *
 *   - MOCK: a scripted MockProvider stages a design per spec (a couple correct →
 *     score `built`, one wrong → score the right failed criterion). The loop still
 *     DRIVES the whole build→gate→score cycle through the real air-ts gate. This is
 *     the CI-safe surface: it validates harness + scorer mechanics + stop
 *     conditions deterministically, with no network and (for the correct builds)
 *     no ngspice — the mock's correct builds omit sim_assertion specs so CI stays
 *     offline; the scorer runs its structural + erc checks.
 *   - LIVE: a real provider (BYOK) builds each spec from its NL prompt. The scored
 *     numbers are written to bench/results/build-<date>-<provider>.json.
 *
 * The runner is engine-agnostic: it takes the air-ts facade + a provider factory,
 * so the CI vitest test (aliased air-ts, mock provider) and the CLI (relative
 * air-ts, real provider) share it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockProvider, type AgentProvider, type MockFixture, type ScriptedEvent } from "../../src/index.js";
import { buildEngine, type AirTsFacade } from "./engine.js";
import { runBuildLoop, isBuilt, type BuildStopReason, type IterationLogEntry } from "./loop.js";
import { loadBuildSpecs, type BuildSpec } from "./specs.js";
import { subprocessScorer, type BuildScore, type ScoreFn } from "./scorer.js";

export type { AirTsFacade } from "./engine.js";

/** One scored build case. */
export interface BuildCaseResult {
  readonly id: string;
  readonly category: string;
  readonly fidelity: string;
  readonly built: boolean;
  readonly stopReason: BuildStopReason;
  readonly failedCriterion: string | null;
  readonly turns: number;
  readonly tokens: number;
  readonly simBackend: string | null;
  readonly simValue: number | null;
  readonly message: string;
  /**
   * Compact per-iteration log — tool names called, tokens, staged y/n, scorer
   * verdict summary. Enough to reason about a no_progress or a bad score without
   * a live re-run (per coordinator: "diagnostic logging so we can reason about
   * build failures without spending money").
   */
  readonly iterations_log: IterationLogEntry[];
}

/** The whole build-benchmark run's result (committed in live mode). */
export interface BuildBenchReport {
  readonly provider: string;
  readonly model: string | null;
  readonly mode: "mock" | "live";
  readonly date: string;
  readonly totalSpecs: number;
  readonly builtCount: number;
  readonly cases: BuildCaseResult[];
}

export interface RunBuildBenchOptions {
  /** The injected air-ts facade (aliased in vitest, relative in the CLI). */
  air: AirTsFacade;
  /** Mock, or a real-provider factory for live mode. */
  mode: "mock" | "live";
  /** Absolute repo root (scorer + live sim subprocess PYTHONPATH). */
  repoRoot: string;
  /** Python executable for the scorer / live sim subprocesses. */
  pythonBin?: string;
  /**
   * Override the objective scorer (the CI mock test injects a deterministic one
   * so it runs offline). Defaults to the Python subprocess scorer.
   */
  scoreFn?: ScoreFn;
  /** Live-mode provider factory (required when mode === "live"). */
  makeLiveProvider?: () => AgentProvider;
  /** Provider label for the report (e.g. "mock" / "anthropic"). */
  providerLabel: string;
  /** Model id for the report + provider messages. */
  model?: string;
  /** Max tokens per provider turn. */
  maxTokensPerTurn?: number;
  /** A fixed date string for deterministic mock reports (tests). */
  date?: string;
  /** Delay (ms) between specs (live throttling). 0 in mock. */
  specDelayMs?: number;
  /** A specific set of spec ids to run (else all). */
  only?: string[];
  /** Limit to the first N specs (after `only` filtering). */
  limit?: number;
  /**
   * If set, write each spec's FINAL built design XML to `<dir>/<id>.air.xml` for
   * failure inspection. Local diagnostics only (gitignored) — honest failure
   * analysis per AGENTS.md, never committed design dumps.
   */
  saveDesignsDir?: string;
  /**
   * HARD absolute per-spec token cap. If a spec's cumulative tokens exceed this
   * between build iterations, the case ENDS with stop reason `token_cap`.
   * Belt-and-suspenders on top of the per-iteration BudgetLimits in the loop —
   * this is what guarantees a bounded live spend across build iterations.
   */
  perSpecTokenCap?: number;
  /**
   * A mock-fixture factory keyed by spec — REQUIRED in mock mode. The runner does
   * not know how to script a build; the mock CI test supplies deterministic
   * fixtures (correct builds + one deliberate wrong build). This keeps all
   * spec-specific scripting in the TEST, never in the runner (grep-clean).
   */
  mockFixtureForSpec?: (spec: BuildSpec) => MockFixture;
  /** Progress callback (per case). */
  onCase?: (result: BuildCaseResult) => void;
}

/** Run the whole build benchmark and return the scored report. */
export async function runBuildBenchmark(opts: RunBuildBenchOptions): Promise<BuildBenchReport> {
  let specs = loadBuildSpecs();
  if (opts.only && opts.only.length > 0) {
    const want = new Set(opts.only);
    specs = specs.filter((s) => want.has(s.id));
  }
  if (typeof opts.limit === "number" && opts.limit >= 0) {
    specs = specs.slice(0, opts.limit);
  }

  const hooks = buildEngine(opts.air, {
    mode: opts.mode,
    repoRoot: opts.repoRoot,
    ...(opts.pythonBin ? { pythonBin: opts.pythonBin } : {}),
  });
  const scoreFn: ScoreFn =
    opts.scoreFn ??
    subprocessScorer({
      repoRoot: opts.repoRoot,
      ...(opts.pythonBin ? { pythonBin: opts.pythonBin } : {}),
    });
  const specDelayMs = opts.specDelayMs ?? 0;
  const results: BuildCaseResult[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (i > 0 && specDelayMs > 0) await sleep(specDelayMs);

    const provider =
      opts.mode === "mock"
        ? new MockProvider(requireMockFixture(opts, spec))
        : requireLiveProvider(opts)();

    let result: BuildCaseResult;
    try {
      const build = await runBuildLoop({
        spec,
        provider,
        hooks,
        scoreFn,
        ...(opts.maxTokensPerTurn !== undefined ? { maxTokensPerTurn: opts.maxTokensPerTurn } : {}),
        ...(opts.model ? { modelId: opts.model } : {}),
        ...(opts.perSpecTokenCap !== undefined ? { perSpecTokenCap: opts.perSpecTokenCap } : {}),
        idFactory: makeIdFactory(spec.id),
      });
      if (opts.saveDesignsDir) {
        mkdirSync(opts.saveDesignsDir, { recursive: true });
        writeFileSync(join(opts.saveDesignsDir, `${spec.id}.air.xml`), build.finalXml, "utf-8");
      }
      result = toCaseResult(spec, build.reason, build.score, build.iterations, build.totalTokens, build.message, build.log);
    } catch (err) {
      // A spec that throws is scored as not-built with the error surfaced —
      // never silently dropped (honest numbers).
      result = {
        id: spec.id,
        category: spec.category,
        fidelity: spec.fidelity,
        built: false,
        stopReason: "error",
        failedCriterion: null,
        turns: 0,
        tokens: 0,
        simBackend: null,
        simValue: null,
        message: `error: ${(err as Error).message}`,
        iterations_log: [],
      };
    }
    results.push(result);
    opts.onCase?.(result);
  }

  // Record the ACTUAL model used, not just what --model set — a live provider
  // falls back to its defaultModel when --model is omitted (pre-cap smoke had
  // model=null for exactly this reason).
  const modelResolved = resolveReportModel(opts);

  return {
    provider: opts.providerLabel,
    model: modelResolved,
    mode: opts.mode,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    totalSpecs: results.length,
    builtCount: results.filter((r) => r.built).length,
    cases: results,
  };
}

/** Resolve the model to record in the report: explicit --model wins, else the
 *  live provider's default (probed by constructing one), else null (mock). */
function resolveReportModel(opts: RunBuildBenchOptions): string | null {
  if (opts.model) return opts.model;
  if (opts.mode === "live" && opts.makeLiveProvider) {
    try {
      return opts.makeLiveProvider().defaultModel;
    } catch {
      return null;
    }
  }
  return null;
}

function toCaseResult(
  spec: BuildSpec,
  reason: BuildStopReason,
  score: BuildScore | null,
  turns: number,
  tokens: number,
  message: string,
  iterations_log: IterationLogEntry[],
): BuildCaseResult {
  return {
    id: spec.id,
    category: spec.category,
    fidelity: spec.fidelity,
    built: isBuilt(reason),
    stopReason: reason,
    failedCriterion: score?.failed_criterion ?? null,
    turns,
    tokens,
    simBackend: score?.sim_backend ?? null,
    simValue: score?.sim_value ?? null,
    message,
    iterations_log,
  };
}

function requireLiveProvider(opts: RunBuildBenchOptions): () => AgentProvider {
  if (!opts.makeLiveProvider) throw new Error("build-bench: live mode requires a makeLiveProvider factory");
  return opts.makeLiveProvider;
}

function requireMockFixture(opts: RunBuildBenchOptions, spec: BuildSpec): MockFixture {
  if (!opts.mockFixtureForSpec) throw new Error("build-bench: mock mode requires a mockFixtureForSpec factory");
  return opts.mockFixtureForSpec(spec);
}

function makeIdFactory(seed: string): () => string {
  let n = 0;
  return () => `${seed}-proposal-${++n}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a mock turn that stages a full design via set_design, then a terminal
 * turn. A helper the mock CI test uses to script deterministic builds without
 * duplicating the streaming-event shape.
 */
export function stageDesignTurns(designXml: string, summary: string, toolCallId: string): ScriptedEvent[][] {
  const stageTurn: ScriptedEvent[] = [
    { type: "text-delta", text: `Building circuit... ${summary}` },
    { type: "tool-call", id: toolCallId, name: "set_design", args: { design_xml: designXml, summary } },
    { type: "usage", inputTokens: 200, outputTokens: 80 },
    { type: "done", stopReason: "tool_use" },
  ];
  const closeTurn: ScriptedEvent[] = [
    { type: "text-delta", text: "Staged the design." },
    { type: "usage", inputTokens: 40, outputTokens: 10 },
    { type: "done", stopReason: "stop" },
  ];
  return [stageTurn, closeTurn];
}

/** Serialize a report to a stable, sorted JSON string (committed artifact). */
export function serializeBuildReport(report: BuildBenchReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
