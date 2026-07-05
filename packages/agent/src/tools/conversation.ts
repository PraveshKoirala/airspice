/**
 * The conversation runner (issue #18 deliverable 5): drives a provider through
 * the tool loop against the ToolRuntime, with the epic's budgets and a Stop.
 *
 * Responsibilities:
 *   - System prompt from the ported prompts (prompts.ts); Building/Editing modes
 *     preserved (they live in the tuned prompt text, unchanged).
 *   - Tool loop: for each provider turn, stream events; execute each tool call
 *     through the runtime; feed the (bounded) tool result back as a `tool`
 *     message; continue while the model asks for more tools (stopReason
 *     "tool_use") and the budget holds.
 *   - Budgets (epic #16 decision 4): max iterations / tokens / wall time,
 *     enforced in code (BudgetCounter) and surfaced via `onEvent` so the UI
 *     shows them. When exhausted, the loop stops with a `budget` event.
 *   - Recovery ladder (#17 post-audit amendment): a malformed tool call feeds
 *     ONE structured error back per turn; a SECOND consecutive malformed
 *     emission in the same turn aborts the turn with a provider/model-named
 *     message; ladder events surface as subdued system notes and increment a
 *     per-session counter.
 *   - Stop: the caller's AbortSignal aborts the provider stream AND is passed to
 *     each tool execution, so an in-flight simulation is canceled (the runtime
 *     forwards it to the sim-wasm terminate-and-respawn cancel, ADR 0011).
 *
 * The runner is engine- and provider-agnostic: it takes an `AgentProvider` and a
 * `ToolRuntime`. In CI the provider is the MockProvider replaying scripted
 * tool-call sequences and the runtime's hooks are the real air-ts gate.
 */

import type { AgentProvider, Msg, AgentEvent } from "../types.js";
import { malformedToolResult, type ParsedToolArgs } from "../repair.js";
import type { ToolRuntime } from "./runtime.js";
import type { StagedProposal } from "./staging.js";
import { BudgetCounter, type BudgetLimits, type BudgetUsage } from "./budget.js";
import { capToolResult } from "./truncate.js";

/** Events the runner emits so the UI can render the transcript + meters. */
export type RunnerEvent =
  | { type: "assistant-text"; text: string }
  | { type: "tool-call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool-result"; id: string; name: string; result: string }
  | { type: "proposal-staged"; proposal: StagedProposal }
  | { type: "system-note"; note: string }
  | { type: "budget"; usage: BudgetUsage }
  | { type: "malformed"; provider: string; model: string; detail: string; count: number }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; reason: RunEndReason }
  | { type: "error"; message: string };

/** Why the run ended. */
export type RunEndReason =
  | "completed" // model finished (stopReason stop)
  | "budget_iterations"
  | "budget_tokens"
  | "budget_wall_time"
  | "aborted" // Stop pressed
  | "malformed_twice" // recovery ladder step 2
  | "provider_error";

export interface RunConversationOptions {
  provider: AgentProvider;
  runtime: ToolRuntime;
  /** The user's message for this run. */
  userMessage: string;
  /** Prior conversation turns (user/assistant/tool messages). */
  history?: Msg[];
  /** System prompt (from prompts.ts chatSystemInstruction()). */
  system: string;
  /** Max tokens per provider turn (the settings token budget). */
  maxTokensPerTurn: number;
  /** Loop budgets (iterations/tokens/wall-time). */
  budget?: Partial<BudgetLimits>;
  /** Stop button: aborts the provider stream AND cancels in-flight simulation. */
  signal: AbortSignal;
  /** Sink for runner events (UI transcript + meters). */
  onEvent: (event: RunnerEvent) => void;
  /** Model id for ladder messages ("<model> produced unparseable..."). */
  modelId?: string;
  /** Injectable clock for the wall-time budget (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Per-session malformed-tool-call counter (the settings counter). Passed in so
   * it persists across runs; the runner increments it and echoes the value.
   */
  malformedCounter?: { count: number };
}

/**
 * Run the conversation to completion (or budget/stop/error). Returns the final
 * end reason and the appended message list (so the caller can persist history).
 */
export async function runConversation(
  opts: RunConversationOptions,
): Promise<{ reason: RunEndReason; messages: Msg[] }> {
  const {
    provider, runtime, system, maxTokensPerTurn, signal, onEvent,
  } = opts;
  const modelId = opts.modelId ?? provider.defaultModel;
  const counter = opts.malformedCounter ?? { count: 0 };
  const budget = new BudgetCounter(
    { ...defaultLimits(), ...(opts.budget ?? {}) },
    opts.now,
  );

  const messages: Msg[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.userMessage },
  ];

  let reason: RunEndReason = "completed";

  // The tool loop. Each pass is one provider turn; it continues while the model
  // asks for tools (stopReason tool_use) and the budget/stop allow it.
  for (;;) {
    if (signal.aborted) {
      reason = "aborted";
      break;
    }
    const startExhaustion = budget.startIteration();
    if (startExhaustion) {
      reason = budgetReason(startExhaustion);
      onEvent({ type: "budget", usage: budget.usage() });
      break;
    }
    onEvent({ type: "budget", usage: budget.usage() });

    // --- Stream one provider turn, collecting text + tool calls. ---------- //
    const turn = await streamTurn(
      provider,
      { system, messages, tools: runtime.tools, maxTokens: maxTokensPerTurn, signal },
      onEvent,
      budget,
    );

    if (turn.error) {
      onEvent({ type: "error", message: turn.error });
      reason = "provider_error";
      break;
    }
    if (turn.aborted || signal.aborted) {
      reason = "aborted";
      break;
    }
    // Append the assistant's turn, PRESERVING its tool-use blocks (issue #101).
    // A turn with tool calls must be replayed to the provider with EVERY tool
    // call's id, so the `tool_result` blocks appended below reference valid ids.
    // Flattening this to plain text (the old behavior) orphaned those ids and
    // 400'd on Anthropic/OpenAI/Gemini the moment a tool_result was echoed back
    // — which happens on any multi-tool-call turn (the i2c SDA+SCL case) or any
    // multi-turn tool loop. Include EVERY call the model made this turn (well-
    // formed AND malformed): each gets a `tool` reply below (or the turn aborts
    // and no further provider round-trip occurs), so the ids stay balanced.
    if (turn.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: turn.text,
        toolCalls: turn.toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      });
    } else if (turn.text) {
      messages.push({ role: "assistant", content: turn.text });
    }

    // --- No tool calls: the model gave a final answer. Done. -------------- //
    if (turn.toolCalls.length === 0) {
      reason = "completed";
      break;
    }

    // --- Execute tool calls, applying the recovery ladder for malformed. -- //
    // Ladder state is PER TURN: one malformed feedback is allowed; a second
    // consecutive malformed emission aborts the turn (#17 amendment step 2).
    let malformedThisTurn = 0;
    let turnAborted = false;
    for (const call of turn.toolCalls) {
      if (signal.aborted) {
        turnAborted = true;
        break;
      }

      if (call.malformed) {
        malformedThisTurn += 1;
        counter.count += 1;
        onEvent({
          type: "malformed",
          provider: provider.id,
          model: modelId,
          detail: call.malformed.detail,
          count: counter.count,
        });
        onEvent({
          type: "system-note",
          note: `The model emitted a malformed tool call (${call.malformed.kind}): ${call.malformed.detail}`,
        });

        if (malformedThisTurn >= 2) {
          // Step 2: abort the turn, name the provider + model. Never loop.
          onEvent({
            type: "system-note",
            note: `${modelId} (${provider.id}) produced unparseable tool calls twice; try re-sending or switching models.`,
          });
          reason = "malformed_twice";
          turnAborted = true;
          break;
        }
        // Step 1: feed ONE structured error back as the tool result.
        const errorResult = capToolResult(malformedToolResult(call.malformed));
        messages.push({
          role: "tool",
          content: errorResult,
          toolCallId: call.id,
          toolName: call.name,
        });
        onEvent({ type: "tool-result", id: call.id, name: call.name, result: errorResult });
        continue;
      }

      // A well-formed tool call: execute it through the runtime.
      onEvent({ type: "tool-call", id: call.id, name: call.name, args: call.args! });
      const exec = await runtime.execute(call.name, call.args!, signal);
      messages.push({
        role: "tool",
        content: exec.result,
        toolCallId: call.id,
        toolName: call.name,
      });
      onEvent({ type: "tool-result", id: call.id, name: call.name, result: exec.result });
      if (exec.staged) {
        onEvent({ type: "proposal-staged", proposal: exec.staged });
      }
      if (exec.aborted || signal.aborted) {
        turnAborted = true;
        break;
      }
    }

    if (reason === "malformed_twice") break;
    if (turnAborted || signal.aborted) {
      reason = "aborted";
      break;
    }
    // Otherwise loop: the model gets the tool results and continues.
  }

  onEvent({ type: "budget", usage: budget.usage() });
  onEvent({ type: "done", reason });
  return { reason, messages };
}

// --------------------------------------------------------------------------- //
// One provider turn: stream events, reassemble text + parsed tool calls.
// --------------------------------------------------------------------------- //

interface CollectedCall {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  malformed?: ParsedToolArgs["malformed"];
}

interface TurnResult {
  text: string;
  toolCalls: CollectedCall[];
  stopReason: "stop" | "tool_use" | "max_tokens" | "aborted" | null;
  aborted: boolean;
  error?: string;
}

async function streamTurn(
  provider: AgentProvider,
  req: { system: string; messages: Msg[]; tools: ToolRuntime["tools"]; maxTokens: number; signal: AbortSignal },
  onEvent: (e: RunnerEvent) => void,
  budget: BudgetCounter,
): Promise<TurnResult> {
  const result: TurnResult = { text: "", toolCalls: [], stopReason: null, aborted: false };
  let textBuf = "";

  try {
    for await (const ev of provider.chat(req) as AsyncIterable<AgentEvent>) {
      if (req.signal.aborted) {
        result.aborted = true;
        break;
      }
      switch (ev.type) {
        case "text-delta":
          textBuf += ev.text;
          onEvent({ type: "assistant-text", text: ev.text });
          break;
        case "tool-call":
          // The provider already parsed/validated args against the schema
          // (repair.ts). We forward `malformed` so the ladder keys off it.
          result.toolCalls.push({
            id: ev.id,
            name: ev.name,
            args: ev.args,
            ...(ev.malformed ? { malformed: ev.malformed } : {}),
          });
          break;
        case "usage":
          budget.addTokens(ev.inputTokens, ev.outputTokens);
          onEvent({ type: "usage", inputTokens: ev.inputTokens, outputTokens: ev.outputTokens });
          break;
        case "done":
          result.stopReason = ev.stopReason;
          if (ev.stopReason === "aborted") result.aborted = true;
          break;
        case "error":
          result.error = ev.message;
          break;
      }
    }
  } catch (err) {
    result.error = (err as Error).message;
  }

  result.text = textBuf;
  return result;
}

// --------------------------------------------------------------------------- //
// Small helpers.
// --------------------------------------------------------------------------- //

function budgetReason(e: "iterations" | "tokens" | "wall_time"): RunEndReason {
  return e === "iterations"
    ? "budget_iterations"
    : e === "tokens"
    ? "budget_tokens"
    : "budget_wall_time";
}

function defaultLimits(): BudgetLimits {
  // Mirrors budget.ts DEFAULT_BUDGET; inlined so the runner's default does not
  // depend on a value import that a caller could tree-shake unexpectedly.
  return { maxIterations: 12, maxTokens: 200_000, maxWallMs: 120_000 };
}
