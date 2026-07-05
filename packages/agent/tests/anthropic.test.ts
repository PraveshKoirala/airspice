import { describe, it, expect } from "vitest";
import { AnthropicProvider } from "../src/index.js";
import {
  collect,
  errorResponse,
  fakeKey,
  joinText,
  makeRequest,
  sseEvents,
  sseResponse,
  stubFetch,
  toolCalls,
} from "./helpers.js";

const KEY = fakeKey("sk-ant-", "secretkeyabcdefghijklmnop");

/** A well-formed Anthropic streaming sequence: text + one tool call. */
function anthropicStream(): Response {
  return sseEvents([
    { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "validate_design" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"design_path\"" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ": \"a.air.xml\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 50, output_tokens: 12 } },
    { type: "message_stop" },
  ]);
}

describe("AnthropicProvider", () => {
  it("reassembles streamed text and parses a tool call (happy path)", async () => {
    const { fetchImpl, calls } = stubFetch(() => anthropicStream());
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));

    expect(joinText(events)).toBe("Hello, world.");
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.name).toBe("validate_design");
    expect(tc[0]!.args).toEqual({ design_path: "a.air.xml" });
    expect(events.some((e) => e.type === "usage" && e.outputTokens === 12)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });

    // Direct call to the real endpoint with the CORS opt-in header, no relay.
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["x-api-key"]).toBe(KEY);
  });

  it("sets stopReason=stop on a plain text turn", async () => {
    const stream = sseEvents([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
    ]);
    const { fetchImpl } = stubFetch(() => stream);
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
  });

  it("retries on 429 then succeeds (max-3 backoff)", async () => {
    let n = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      n++;
      if (n === 1) return errorResponse(429, "rate limited", { "retry-after": "0" });
      return anthropicStream();
    });
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(calls).toHaveLength(2);
    expect(joinText(events)).toBe("Hello, world.");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("surfaces a non-retryable 401 as a typed auth error", async () => {
    const { fetchImpl, calls } = stubFetch(() => errorResponse(401, "unauthorized"));
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(calls).toHaveLength(1); // no retry
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", kind: "auth", retryable: false });
  });

  it("marks a truncated tool-call stream as malformed", async () => {
    // Stream cuts off mid input_json (no closing brace, no content_block_stop).
    const stream = sseEvents([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_x", name: "validate_design" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"design_path\": \"a" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
    ]);
    const { fetchImpl } = stubFetch(() => stream);
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.args).toBeNull();
    expect(tc[0]!.malformed?.kind).toBe("invalid_json");
  });

  it("propagates AbortSignal: aborts before the request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch(() => anthropicStream());
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest({ signal: controller.signal })));
    expect(calls).toHaveLength(0);
    expect(events).toEqual([{ type: "error", kind: "aborted", retryable: false, message: "Request aborted" }]);
  });

  it("handles a chunk boundary splitting an SSE line", async () => {
    // Same events as the happy path but chunked mid-line to test the reader.
    const full =
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n\n` +
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Split" } })}\n\n` +
      `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} })}\n\n`;
    const mid = Math.floor(full.length / 2);
    const { fetchImpl } = stubFetch(() => sseResponse([full.slice(0, mid), full.slice(mid)]));
    const provider = new AnthropicProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(joinText(events)).toBe("Split");
  });
});
