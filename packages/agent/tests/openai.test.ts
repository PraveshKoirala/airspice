import { describe, it, expect } from "vitest";
import { OpenAIProvider } from "../src/index.js";
import {
  collect,
  errorResponse,
  fakeKey,
  FAST_RETRY,
  joinText,
  makeRequest,
  sseEvents,
  stubFetch,
  toolCalls,
} from "./helpers.js";

const KEY = fakeKey("sk-", "openaisecretkeyABCDEFGHIJKLMNOP");

function openaiTextStream(): Response {
  return sseEvents([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
    { choices: [{ index: 0, delta: { content: " there" } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ]);
}

function openaiToolStream(): Response {
  return sseEvents([
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call_abc", function: { name: "validate_design", arguments: "{\"design_" } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "path\": \"b.air.xml\"}" } }] } },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } },
  ]);
}

describe("OpenAIProvider", () => {
  it("reassembles streamed text (happy path)", async () => {
    const { fetchImpl, calls } = stubFetch(() => openaiTextStream());
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(joinText(events)).toBe("Hi there");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
    expect(events.some((e) => e.type === "usage" && e.outputTokens === 5)).toBe(true);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${KEY}`);
  });

  it("accumulates a tool call across chunks and parses args", async () => {
    const { fetchImpl } = stubFetch(() => openaiToolStream());
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.id).toBe("call_abc");
    expect(tc[0]!.name).toBe("validate_design");
    expect(tc[0]!.args).toEqual({ design_path: "b.air.xml" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("retries on 500 then succeeds", async () => {
    let n = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      n++;
      return n === 1 ? errorResponse(500, "server error") : openaiTextStream();
    });
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl, retry: FAST_RETRY });
    const events = await collect(provider.chat(makeRequest()));
    expect(calls).toHaveLength(2);
    expect(joinText(events)).toBe("Hi there");
  });

  it("gives up after max retries on persistent 429 (typed quota error)", async () => {
    const { fetchImpl, calls } = stubFetch(() => errorResponse(429, "slow down", { "retry-after": "0" }));
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl, retry: FAST_RETRY });
    const events = await collect(provider.chat(makeRequest()));
    // 1 initial + 3 retries = 4 attempts.
    expect(calls).toHaveLength(4);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", kind: "quota", retryable: true, status: 429 });
  });

  it("flags a malformed streamed tool call (unknown tool)", async () => {
    const stream = sseEvents([
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "nuke", arguments: "{}" } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const { fetchImpl } = stubFetch(() => stream);
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events)[0]!;
    expect(tc.args).toBeNull();
    expect(tc.malformed?.kind).toBe("unknown_tool");
  });

  it("propagates AbortSignal (aborts before request)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch(() => openaiTextStream());
    const provider = new OpenAIProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest({ signal: controller.signal })));
    expect(calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", kind: "aborted" });
  });
});
