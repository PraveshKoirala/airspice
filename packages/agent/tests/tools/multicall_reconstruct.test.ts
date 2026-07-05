/**
 * Regression guard for issue #101: a multi-tool-call assistant turn must be
 * REPLAYED to the provider with its tool-use blocks intact, so the following
 * tool_result blocks reference VALID tool_use ids.
 *
 * The bug: the conversation runner reconstructed an assistant turn that made
 * tool calls as PLAIN TEXT and dropped the tool_use blocks; the tool_result
 * messages it then appended referenced orphaned ids. On any turn that issues
 * two tool calls (the live i2c_without_pullups case: SDA + SCL pull-ups in one
 * turn) OR any multi-turn tool loop that echoes a tool_result back, this 400'd
 * on Anthropic ("tool_result block without a matching tool_use") and would 400
 * identically on OpenAI (a `tool` message not preceded by `tool_calls`) and
 * Gemini (a functionResponse with no matching functionCall).
 *
 * These tests reproduce the failure DETERMINISTICALLY with no network:
 *
 *   1. RUNNER LEVEL (mock provider + real air-ts gate): a scripted 2-tool-call
 *      turn drives the real runConversation; we assert the reconstructed message
 *      list carries an assistant message whose tool_use ids EXACTLY match the two
 *      following tool-result messages' ids. On main the assistant message had no
 *      `toolCalls`, so this assertion fails.
 *
 *   2. PROVIDER FORMAT (real Anthropic + real OpenAI, stubbed fetch): the runner
 *      drives the REAL provider; turn 1's fetch returns a 2-tool-call SSE stream,
 *      turn 2's fetch CAPTURES the outgoing request body. We assert every
 *      tool_result / tool id in that body has a matching tool_use / tool_calls id
 *      in the preceding assistant message — the exact contract the provider API
 *      enforces with a 400. On main the captured body is unbalanced (assistant
 *      text, no tool_use), so these assertions fail. This is the CI-safe stand-in
 *      for the provider's 400.
 */

import { describe, it, expect } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  MockProvider,
  ToolRuntime,
  runConversation,
  GOLDEN_DESIGN,
  chatSystemInstruction,
  type Msg,
  type MockFixture,
  type RunnerEvent,
} from "../../src/index.js";
import { realAirTsEngine } from "./engineAdapter.js";
import { fakeKey, sseEvents } from "../helpers.js";

/**
 * Two propose_patch calls in ONE turn — the shape of i2c_without_pullups (SDA
 * pull-up + SCL pull-up). The first patch is a valid edit against GOLDEN_DESIGN;
 * the second targets a missing element so the gate rejects it. BOTH still get a
 * `tool` reply (a gate rejection is fed back as the result), so BOTH ids must
 * round-trip — the id-balance is what the fix guarantees, independent of the
 * gate outcome.
 */
const PATCH_A = `<patch id="p_a">
  <reason>SDA pull-up</reason>
  <replace path="/system/components/component[@id='R_BOT']/value"><value>4.7k</value></replace>
</patch>`;
const PATCH_B = `<patch id="p_b">
  <reason>SCL pull-up</reason>
  <replace path="/system/components/component[@id='R_TOP']/value"><value>4.7k</value></replace>
</patch>`;

function twoCallFixture(): MockFixture {
  return {
    turns: [
      // Turn 1: prose + TWO tool calls, then done(tool_use).
      [
        { type: "text-delta", text: "Adding both I2C pull-ups." },
        { type: "tool-call", id: "call_sda", name: "propose_patch", args: { patch_xml: PATCH_A, summary: "SDA pull-up" } },
        { type: "tool-call", id: "call_scl", name: "propose_patch", args: { patch_xml: PATCH_B, summary: "SCL pull-up" } },
        { type: "usage", inputTokens: 100, outputTokens: 40 },
        { type: "done", stopReason: "tool_use" },
      ],
      // Turn 2: the model has both results and finishes.
      [
        { type: "text-delta", text: "Both pull-ups staged." },
        { type: "done", stopReason: "stop" },
      ],
    ],
  };
}

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

// --------------------------------------------------------------------------- //
// 1. Runner level: the reconstructed history keeps the tool_use blocks.
// --------------------------------------------------------------------------- //

describe("issue #101 — multi-tool-call turn reconstruction (runner level)", () => {
  it("keeps BOTH tool_use ids on the assistant turn and matches both tool results", async () => {
    const runtime = new ToolRuntime(
      { xml: GOLDEN_DESIGN, version: 0 },
      { hooks: realAirTsEngine() },
    );
    const s = sink();
    const { reason, messages } = await runConversation({
      provider: new MockProvider(twoCallFixture()),
      runtime,
      userMessage: "add SDA and SCL pull-ups",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: s.onEvent,
    });

    expect(reason).toBe("completed");

    // The assistant turn that made the calls must carry BOTH tool calls.
    const assistantWithCalls = messages.find(
      (m): m is Msg => m.role === "assistant" && !!m.toolCalls && m.toolCalls.length > 0,
    );
    expect(assistantWithCalls, "assistant turn must preserve its tool_use blocks").toBeDefined();
    const callIds = assistantWithCalls!.toolCalls!.map((c) => c.id);
    expect(callIds).toEqual(["call_sda", "call_scl"]);

    // Every tool-result message references an id present on that assistant turn
    // (no orphans) — the exact balance a provider enforces with a 400.
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    const resultIds = toolMsgs.map((m) => m.toolCallId);
    expect(resultIds.sort()).toEqual([...callIds].sort());
    for (const id of resultIds) {
      expect(callIds, `tool_result ${id} must have a matching tool_use`).toContain(id);
    }
  });
});

// --------------------------------------------------------------------------- //
// 2. Provider format: the wire request body is balanced (Anthropic + OpenAI).
// --------------------------------------------------------------------------- //

/**
 * A stub fetch that returns turn 1's 2-tool-call stream first, then CAPTURES
 * turn 2's request body (parsed JSON) and returns a terminal stop stream.
 */
function captureSecondTurn(
  firstTurn: () => Response,
  terminal: () => Response,
): { fetchImpl: typeof fetch; getSecondBody: () => Record<string, unknown> } {
  let n = 0;
  let secondBody: Record<string, unknown> | null = null;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    n += 1;
    if (n === 1) return firstTurn();
    if (n === 2) {
      secondBody = JSON.parse(String(init?.body ?? "{}"));
      return terminal();
    }
    return terminal();
  }) as typeof fetch;
  return { fetchImpl, getSecondBody: () => secondBody ?? {} };
}

/** Anthropic: a two-tool_use stream ending in stop_reason: tool_use. */
function anthropicTwoToolStream(): Response {
  return sseEvents([
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Adding both pull-ups." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_sda", name: "propose_patch" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ patch_xml: PATCH_A, summary: "SDA" }) } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_scl", name: "propose_patch" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify({ patch_xml: PATCH_B, summary: "SCL" }) } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 60, output_tokens: 30 } },
    { type: "message_stop" },
  ]);
}

function anthropicStopStream(): Response {
  return sseEvents([
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
  ]);
}

/** OpenAI: two tool_calls (index 0 + 1) ending in finish_reason: tool_calls. */
function openaiTwoToolStream(): Response {
  return sseEvents([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Adding both pull-ups." } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_sda", function: { name: "propose_patch", arguments: JSON.stringify({ patch_xml: PATCH_A, summary: "SDA" }) } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_scl", function: { name: "propose_patch", arguments: JSON.stringify({ patch_xml: PATCH_B, summary: "SCL" }) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 60, completion_tokens: 30 } },
  ]);
}

function openaiStopStream(): Response {
  return sseEvents([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Done." } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ]);
}

describe("issue #101 — provider request body is balanced on the follow-up turn", () => {
  it("Anthropic: the second-turn body has a matching tool_use for every tool_result", async () => {
    const { fetchImpl, getSecondBody } = captureSecondTurn(anthropicTwoToolStream, anthropicStopStream);
    const provider = new AnthropicProvider({ apiKey: fakeKey("sk-ant-", "abcdefghijklmnopqrstuvwx"), fetchImpl });
    const runtime = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const { reason } = await runConversation({
      provider,
      runtime,
      userMessage: "add SDA and SCL pull-ups",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(reason).toBe("completed");

    const body = getSecondBody();
    const messages = body["messages"] as { role: string; content: unknown }[];

    // Collect every tool_use id (from assistant content arrays) and every
    // tool_result tool_use_id (from user content arrays).
    const toolUseIds = new Set<string>();
    const toolResultIds: string[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content as Record<string, unknown>[]) {
        if (block["type"] === "tool_use") toolUseIds.add(String(block["id"]));
        if (block["type"] === "tool_result") toolResultIds.push(String(block["tool_use_id"]));
      }
    }

    expect(toolUseIds).toEqual(new Set(["toolu_sda", "toolu_scl"]));
    expect(toolResultIds.sort()).toEqual(["toolu_scl", "toolu_sda"]);
    for (const id of toolResultIds) {
      expect(toolUseIds.has(id), `tool_result ${id} has no matching tool_use`).toBe(true);
    }
  });

  it("OpenAI: the second-turn body has a matching tool_calls id for every tool message", async () => {
    const { fetchImpl, getSecondBody } = captureSecondTurn(openaiTwoToolStream, openaiStopStream);
    const provider = new OpenAIProvider({ apiKey: fakeKey("sk-", "openaisecretkeyABCDEFGHIJKL"), fetchImpl });
    const runtime = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const { reason } = await runConversation({
      provider,
      runtime,
      userMessage: "add SDA and SCL pull-ups",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(reason).toBe("completed");

    const body = getSecondBody();
    const messages = body["messages"] as Record<string, unknown>[];

    // Every `tool` message's tool_call_id must appear in some preceding
    // assistant message's tool_calls[].id — OpenAI 400s otherwise.
    const toolCallIds = new Set<string>();
    const toolMsgIds: string[] = [];
    for (const m of messages) {
      if (m["role"] === "assistant" && Array.isArray(m["tool_calls"])) {
        for (const tc of m["tool_calls"] as Record<string, unknown>[]) {
          toolCallIds.add(String(tc["id"]));
        }
      }
      if (m["role"] === "tool") toolMsgIds.push(String(m["tool_call_id"]));
    }

    expect(toolCallIds).toEqual(new Set(["call_sda", "call_scl"]));
    expect(toolMsgIds.sort()).toEqual(["call_scl", "call_sda"]);
    for (const id of toolMsgIds) {
      expect(toolCallIds.has(id), `tool message ${id} has no matching tool_calls entry`).toBe(true);
    }

    // The assistant tool-call message must precede its answering tool messages.
    const firstToolIdx = messages.findIndex((m) => m["role"] === "tool");
    const assistantIdx = messages.findIndex(
      (m) => m["role"] === "assistant" && Array.isArray(m["tool_calls"]),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeLessThan(firstToolIdx);
  });

  // ------------------------------------------------------------------------- //
  // Gemini (issue #103): Gemini has NO tool-call ids — the API correlates a
  // `functionResponse` to its `functionCall` by NAME + ORDER. That means the
  // wire-body assertion is subtly different from Anthropic/OpenAI: instead of
  // asserting an id-set balance, we assert that the model turn's functionCall
  // parts and the following functionResponse parts are in the SAME ORDER
  // (position i answers call i, even when both calls share a name — the
  // i2c SDA+SCL shape uses two same-name `propose_patch` calls, so a
  // silent reorder would swap SDA's result onto SCL and vice-versa).
  // ------------------------------------------------------------------------- //

  /**
   * Gemini SSE: one text part + two `functionCall` parts (both named
   * `propose_patch` — the i2c SDA+SCL shape), then a usage event. Gemini
   * emits each functionCall as a COMPLETE object (args already parsed), so
   * one SSE event per call is enough.
   */
  function geminiTwoToolStream(
    argsA: Record<string, unknown>,
    argsB: Record<string, unknown>,
  ): Response {
    return sseEvents([
      { candidates: [{ content: { role: "model", parts: [{ text: "Adding both pull-ups." }] } }] },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "propose_patch", args: argsA } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "propose_patch", args: argsB } }],
            },
          },
        ],
      },
      { usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 30 } },
    ]);
  }

  function geminiStopStream(): Response {
    return sseEvents([
      { candidates: [{ content: { role: "model", parts: [{ text: "Done." } ] }, finishReason: "STOP" }] },
      { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
    ]);
  }

  it("Gemini: second-turn body has 2 ordered functionCall parts + 2 ordered functionResponse parts (same-name)", async () => {
    const { fetchImpl, getSecondBody } = captureSecondTurn(
      () => geminiTwoToolStream(
        { patch_xml: PATCH_A, summary: "SDA" },
        { patch_xml: PATCH_B, summary: "SCL" },
      ),
      geminiStopStream,
    );
    const provider = new GeminiProvider({
      apiKey: fakeKey("AIza", "SyGeminiSecretKeyABCDEFGHIJKLMNOP"),
      fetchImpl,
    });
    const runtime = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const { reason } = await runConversation({
      provider,
      runtime,
      userMessage: "add SDA and SCL pull-ups",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(reason).toBe("completed");

    const body = getSecondBody();
    const contents = body["contents"] as { role: string; parts: unknown[] }[];

    // Walk the wire body in order; capture the model turn's functionCall names
    // and the following user turns' functionResponse names.
    const modelIdx = contents.findIndex((c) => c.role === "model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);

    const modelParts = contents[modelIdx]!.parts as Record<string, unknown>[];
    const functionCallNames = modelParts
      .filter((p) => p["functionCall"])
      .map((p) => String((p["functionCall"] as Record<string, unknown>)["name"]));
    expect(functionCallNames).toEqual(["propose_patch", "propose_patch"]);

    // functionResponses arrive as `role: "user"` contents entries following the
    // model turn — one entry per response. Collect them in wire order.
    const functionResponseNames: string[] = [];
    for (let i = modelIdx + 1; i < contents.length; i++) {
      const entry = contents[i]!;
      if (entry.role !== "user") continue;
      for (const p of entry.parts as Record<string, unknown>[]) {
        const fr = p["functionResponse"] as Record<string, unknown> | undefined;
        if (fr) functionResponseNames.push(String(fr["name"]));
      }
    }
    expect(functionResponseNames).toEqual(["propose_patch", "propose_patch"]);

    // The model turn's functionCall parts must precede the first functionResponse
    // (Gemini 400s otherwise — a functionResponse with no matching functionCall).
    const firstResponseIdx = contents.findIndex(
      (c, i) =>
        i > modelIdx &&
        (c.parts as Record<string, unknown>[]).some((p) => p["functionResponse"]),
    );
    expect(firstResponseIdx).toBeGreaterThan(modelIdx);

    // Order-correlation guard: the model turn's functionCall args (which carry
    // the SDA vs SCL patch bodies) and the following functionResponses (which
    // carry the gate's result payload for each) must be in matching order — if
    // Gemini's name-based correlation ever regressed to a silent reorder,
    // the SDA result would be delivered as the answer to the SCL call.
    const functionCallArgs = modelParts
      .filter((p) => p["functionCall"])
      .map((p) => (p["functionCall"] as Record<string, unknown>)["args"] as Record<string, unknown>);
    expect(functionCallArgs).toHaveLength(2);
    expect(String(functionCallArgs[0]!["summary"])).toBe("SDA");
    expect(String(functionCallArgs[1]!["summary"])).toBe("SCL");
  });

  it("Gemini: swapping the call order in the fixture swaps the wire order (order is what's carried, not name-matched)", async () => {
    // Same two same-name calls, but the fixture emits SCL first and SDA
    // second. Since Gemini correlates by name+order and the calls share a
    // name, the ONLY thing keeping SDA's result attached to SDA's call is
    // that the reconstruction preserves the order the runner observed. If a
    // future change silently sorted or re-keyed the calls (e.g. reordering
    // to "canonical" argument order), this test flags it.
    const { fetchImpl, getSecondBody } = captureSecondTurn(
      () => geminiTwoToolStream(
        { patch_xml: PATCH_B, summary: "SCL" },
        { patch_xml: PATCH_A, summary: "SDA" },
      ),
      geminiStopStream,
    );
    const provider = new GeminiProvider({
      apiKey: fakeKey("AIza", "SyGeminiSecretKeyABCDEFGHIJKLMNOP"),
      fetchImpl,
    });
    const runtime = new ToolRuntime({ xml: GOLDEN_DESIGN, version: 0 }, { hooks: realAirTsEngine() });
    const { reason } = await runConversation({
      provider,
      runtime,
      userMessage: "add SCL and SDA pull-ups",
      system: chatSystemInstruction(),
      maxTokensPerTurn: 1024,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(reason).toBe("completed");

    const body = getSecondBody();
    const contents = body["contents"] as { role: string; parts: unknown[] }[];
    const modelIdx = contents.findIndex((c) => c.role === "model");
    const modelParts = contents[modelIdx]!.parts as Record<string, unknown>[];

    // The wire order now must be SCL, then SDA — matching the emission order,
    // NOT any lexical / name-based reordering.
    const functionCallSummaries = modelParts
      .filter((p) => p["functionCall"])
      .map((p) => String(
        ((p["functionCall"] as Record<string, unknown>)["args"] as Record<string, unknown>)["summary"],
      ));
    expect(functionCallSummaries).toEqual(["SCL", "SDA"]);

    // And each following functionResponse must appear in that same order —
    // Gemini answers call i with response i.
    const responseOrder: string[] = [];
    for (let i = modelIdx + 1; i < contents.length; i++) {
      const entry = contents[i]!;
      if (entry.role !== "user") continue;
      for (const p of entry.parts as Record<string, unknown>[]) {
        const fr = p["functionResponse"] as Record<string, unknown> | undefined;
        if (fr) responseOrder.push(String(fr["name"]));
      }
    }
    expect(responseOrder).toEqual(["propose_patch", "propose_patch"]);
    expect(responseOrder).toHaveLength(2);
  });
});
