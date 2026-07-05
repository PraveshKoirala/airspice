/**
 * The repair-benchmark runner + scorer (issue #19 deliverable 3).
 *
 * Runs the autonomous repair loop over every failing-example case and scores
 * each: fixed?, iterations used, tokens spent, and the stop reason. Two modes:
 *
 *   - MOCK: the MockProvider replays each case's deterministic scripted fix. The
 *     loop still DRIVES the whole simulate→diagnose→patch→re-simulate cycle
 *     through the real air-ts gate. This is the CI-safe surface: it validates the
 *     loop mechanics (convergence to `fixed`) deterministically, no network.
 *   - LIVE: a real provider (BYOK) proposes its own patch each iteration. Used
 *     locally to measure quality; the scored numbers are committed to
 *     bench/results/<date>-<provider>.json so quality is tracked over time.
 *
 * The runner is engine-agnostic: it takes the air-ts facade + a provider factory
 * so the CI vitest test (aliased air-ts, mock provider) and the CLI (relative
 * air-ts, real provider) share it.
 */

import {
  MockProvider,
  runRepairLoop,
  isFixed,
  type AgentProvider,
  type RepairStopReason,
  type MockFixture,
  type ScriptedEvent,
} from "../src/index.js";
import { benchEngine, type AirTsFacade } from "./engine.js";
import { loadBenchCases, type BenchCase } from "./cases.js";

// Re-export the facade shape so the CI bench test imports it from one place.
export type { AirTsFacade } from "./engine.js";

/** One scored case. */
export interface CaseResult {
  readonly name: string;
  readonly fixed: boolean;
  readonly iterations: number;
  readonly tokens: number;
  readonly stopReason: RepairStopReason;
  readonly appliedPatches: number;
  readonly message: string;
}

/** The whole benchmark run's result (committed in live mode). */
export interface BenchReport {
  readonly provider: string;
  readonly model: string | null;
  readonly mode: "mock" | "live";
  readonly date: string;
  readonly maxIterations: number;
  readonly totalCases: number;
  readonly fixedCount: number;
  readonly cases: CaseResult[];
}

export interface RunBenchOptions {
  /** The injected air-ts facade (aliased in vitest, relative in the CLI). */
  air: AirTsFacade;
  /** Mock, or a real-provider factory for live mode. */
  mode: "mock" | "live";
  /** Live-mode provider factory (required when mode === "live"). */
  makeLiveProvider?: () => AgentProvider;
  /** Provider label for the report (e.g. "mock" / "gemini" / "anthropic"). */
  providerLabel: string;
  /** Model id for the report + provider messages. */
  model?: string;
  /** Iteration cap (default 5 — the issue's baseline target window). */
  maxIterations?: number;
  /** Max tokens per provider turn. */
  maxTokensPerTurn?: number;
  /** A fixed date string for deterministic mock reports (tests). */
  date?: string;
  /**
   * Delay (ms) between cases. Live providers (esp. free tiers) rate-limit heavy
   * back-to-back calls; a pause keeps a 429 from masquerading as a model
   * failure. 0 in mock mode. Defaults to 0 (mock) / 20s (live).
   */
  caseDelayMs?: number;
  /**
   * Per-case retries when a case ends in `provider_error` (a rate-limit / 429).
   * A free-tier quota reset is a matter of a minute; retrying after a cooldown
   * gives the model a fair shot rather than scoring a 429 as a model failure.
   * 0 in mock mode. Defaults to 0 (mock) / 2 (live).
   */
  providerErrorRetries?: number;
  /** Cooldown (ms) before a provider-error retry. Defaults to 30s (live). */
  retryCooldownMs?: number;
  /** Optional case-name filter (run only these cases). Defaults to all six. */
  only?: string[];
  /** Progress callback (per case). */
  onCase?: (result: CaseResult) => void;
}

/**
 * Build a MockProvider fixture that replays a case's scripted fix: a turn that
 * calls propose_patch with the known-good patch, then a terminal turn. Beyond
 * the script the mock yields a benign `done`, so if the loop needs no further
 * rounds the mock stays quiet.
 */
export function mockFixtureForCase(caseDef: BenchCase): MockFixture {
  const proposeTurn: ScriptedEvent[] = [
    { type: "text-delta", text: `Editing circuit... ${caseDef.fixSummary}` },
    {
      type: "tool-call",
      id: `fix-${caseDef.name}`,
      name: "propose_patch",
      args: { patch_xml: caseDef.scriptedFix, summary: caseDef.fixSummary },
    },
    { type: "usage", inputTokens: 120, outputTokens: 40 },
    { type: "done", stopReason: "tool_use" },
  ];
  const closeTurn: ScriptedEvent[] = [
    { type: "text-delta", text: "Staged the fix." },
    { type: "done", stopReason: "stop" },
  ];
  return { turns: [proposeTurn, closeTurn] };
}

/** Run the whole benchmark and return the scored report. */
export async function runBenchmark(opts: RunBenchOptions): Promise<BenchReport> {
  const allCases = loadBenchCases();
  const cases = opts.only && opts.only.length > 0
    ? allCases.filter((c) => opts.only!.includes(c.name))
    : allCases;
  const maxIterations = opts.maxIterations ?? 5;
  const hooks = benchEngine(opts.air);
  const results: CaseResult[] = [];
  const caseDelayMs = opts.caseDelayMs ?? (opts.mode === "live" ? 20_000 : 0);
  const providerErrorRetries = opts.providerErrorRetries ?? (opts.mode === "live" ? 2 : 0);
  const retryCooldownMs = opts.retryCooldownMs ?? 30_000;

  for (let i = 0; i < cases.length; i++) {
    const caseDef = cases[i]!;
    // Throttle live runs between cases so a provider rate-limit does not
    // masquerade as the model failing (see the provider_error outcome).
    if (i > 0 && caseDelayMs > 0) await sleep(caseDelayMs);

    let caseResult = await runOneCase(caseDef);
    // A rate-limit (provider_error) gets a bounded retry after a cooldown — a
    // free-tier quota resets in ~a minute, and a 429 is not a model failure.
    for (let attempt = 0; caseResult.stopReason === "provider_error" && attempt < providerErrorRetries; attempt++) {
      await sleep(retryCooldownMs);
      caseResult = await runOneCase(caseDef);
    }
    results.push(caseResult);
    opts.onCase?.(caseResult);
  }

  async function runOneCase(caseDef: BenchCase): Promise<CaseResult> {
    const provider =
      opts.mode === "mock"
        ? new MockProvider(mockFixtureForCase(caseDef))
        : requireLiveProvider(opts)();
    try {
      const result = await runRepairLoop({
        design: caseDef.designXml,
        provider,
        hooks,
        maxIterations,
        ...(opts.model ? { modelId: opts.model } : {}),
        ...(opts.maxTokensPerTurn ? { maxTokensPerTurn: opts.maxTokensPerTurn } : {}),
        // Deterministic proposal ids per case for stable mock reports.
        idFactory: makeIdFactory(caseDef.name),
      });
      return {
        name: caseDef.name,
        fixed: isFixed(result.reason),
        iterations: result.iterations.length,
        tokens: result.totalTokens,
        stopReason: result.reason,
        appliedPatches: result.appliedSteps.length,
        message: result.message,
      };
    } catch (err) {
      // A case that throws is scored as not-fixed with the error surfaced —
      // never silently dropped (honest numbers).
      return {
        name: caseDef.name,
        fixed: false,
        iterations: 0,
        tokens: 0,
        stopReason: "error",
        appliedPatches: 0,
        message: `error: ${(err as Error).message}`,
      };
    }
  }

  return {
    provider: opts.providerLabel,
    model: opts.model ?? null,
    mode: opts.mode,
    date: opts.date ?? new Date().toISOString().slice(0, 10),
    maxIterations,
    totalCases: results.length,
    fixedCount: results.filter((r) => r.fixed).length,
    cases: results,
  };
}

function requireLiveProvider(opts: RunBenchOptions): () => AgentProvider {
  if (!opts.makeLiveProvider) {
    throw new Error("bench: live mode requires a makeLiveProvider factory");
  }
  return opts.makeLiveProvider;
}

function makeIdFactory(seed: string): () => string {
  let n = 0;
  return () => `${seed}-proposal-${++n}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize a report to a stable, sorted JSON string (committed artifact). */
export function serializeReport(report: BenchReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
