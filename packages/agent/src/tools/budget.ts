/**
 * Loop budgets (epic #16 binding decision 4: "Every loop has a budget: max
 * iterations, max tokens, max wall time — enforced in code, surfaced in UI").
 *
 * The conversation runner (conversation.ts) checks the budget BEFORE each
 * provider turn and after each usage event; when any dimension is exhausted the
 * loop stops with a machine-readable reason the UI surfaces. This is code-
 * enforced, not advisory: there is no path where the loop continues past a
 * spent budget.
 *
 * WALL TIME: the runner needs a clock to enforce a wall-time budget. It is
 * injected (`now()`), defaulting to `Date.now`, so tests drive it
 * deterministically (no real timers, no flakiness) and there is no wall-clock
 * READ baked into the loop. NOTE: `packages/agent` is NOT under the co-sim
 * wall-clock-ban roots (mpy-wasm/cosim); a wall-time budget is exactly the
 * "surfaced in UI" budget the epic requires here, and the clock is injectable.
 */

/** The three budget dimensions the epic pins down. */
export interface BudgetLimits {
  /** Max provider turns (tool round-trips) in one conversation run. */
  maxIterations: number;
  /** Max cumulative tokens (input + output) across the run. */
  maxTokens: number;
  /** Max wall-clock milliseconds for the whole run. */
  maxWallMs: number;
}

/** Sensible defaults; the UI may override from the settings token budget. */
export const DEFAULT_BUDGET: BudgetLimits = {
  maxIterations: 12,
  maxTokens: 200_000,
  maxWallMs: 120_000,
};

/** Why a budget check tripped (null === budget remains). */
export type BudgetExhaustion = "iterations" | "tokens" | "wall_time" | null;

/** A live snapshot of budget consumption, for the UI meter. */
export interface BudgetUsage {
  iterations: number;
  tokens: number;
  elapsedMs: number;
  limits: BudgetLimits;
}

/**
 * Mutable budget counter. The runner constructs one per run, calls
 * `startIteration()` before each turn (which both checks and increments), and
 * `addTokens(...)` on each usage event. `check()` is a pure read.
 */
export class BudgetCounter {
  private iterations = 0;
  private tokens = 0;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly limits: BudgetLimits;

  // NOTE: explicit field assignment (not TS parameter properties) so this source
  // compiles under the UI's `erasableSyntaxOnly` when consumed via alias.
  constructor(limits: BudgetLimits = DEFAULT_BUDGET, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.startedAt = now();
  }

  /** Milliseconds elapsed since construction (per the injected clock). */
  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Add token usage from a provider `usage` event. */
  addTokens(input: number, output: number): void {
    this.tokens += Math.max(0, input) + Math.max(0, output);
  }

  /**
   * Pure check: is any dimension already exhausted? Returns the FIRST tripped
   * dimension (iterations, then tokens, then wall time) or null.
   */
  check(): BudgetExhaustion {
    if (this.iterations >= this.limits.maxIterations) return "iterations";
    if (this.tokens >= this.limits.maxTokens) return "tokens";
    if (this.elapsedMs() >= this.limits.maxWallMs) return "wall_time";
    return null;
  }

  /**
   * Attempt to begin an iteration. If the budget is already spent, returns the
   * exhaustion reason and does NOT increment (the loop must stop). Otherwise
   * increments the iteration counter and returns null.
   */
  startIteration(): BudgetExhaustion {
    const exhausted = this.check();
    if (exhausted) return exhausted;
    this.iterations += 1;
    return null;
  }

  /** Snapshot for the UI budget meter. */
  usage(): BudgetUsage {
    return {
      iterations: this.iterations,
      tokens: this.tokens,
      elapsedMs: this.elapsedMs(),
      limits: this.limits,
    };
  }
}
