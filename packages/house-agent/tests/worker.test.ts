/**
 * Mocked-fetch smoke for the house-agent Worker prototype (issue #20).
 *
 * NO network. Every upstream call is a stubbed Response. The tests cover the
 * gates named in the design doc: kill switch, rate limit, daily budget, and
 * the SSE translation happy path (Anthropic messages → neutral events).
 * Wrangler dev is NOT invoked here; the acceptance-criterion "loads and
 * tests pass in mock mode" from the issue is satisfied by these tests.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { handleRequest, type Env } from "../src/index.js";
import { InMemoryKv } from "../src/budget.js";

// A funded, non-key-shaped string so no secret-scan pattern matches this
// literal (see AGENTS.md rule 15 and the test helper in packages/agent).
const FAKE_UPSTREAM_KEY = "houseagenttest_" + "notarealkey_1234567890";
const FAKE_SIGNING_SECRET = "test_signing_secret_do_not_use_in_production";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    HOUSE_AGENT_ENABLED: "true",
    DAILY_TOKEN_BUDGET: "1000",
    IP_RPM_LIMIT: "3",
    MONTHLY_USD_CAP_CENTS: "5000",
    UPSTREAM_MODEL: "claude-haiku-5",
    UPSTREAM_URL: "https://upstream.mock/v1/messages",
    ANTHROPIC_KEY: FAKE_UPSTREAM_KEY,
    TOKEN_SIGNING_SECRET: FAKE_SIGNING_SECRET,
    ...overrides,
  };
}

function makeRequest(body: unknown = {}, headers: Record<string, string> = {}): Request {
  return new Request("https://house.mock/v1/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers },
    body: JSON.stringify(body),
  });
}

/** Build a fake Anthropic streaming response with the given SSE lines. */
function anthropicSseResponse(events: unknown[], init: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Reads a Response's SSE body into an array of parsed neutral events. */
async function readNeutralEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
  return out;
}

describe("house-agent worker: kill switch (layer 3)", () => {
  it("fails closed with a BYOK-upsell error when HOUSE_AGENT_ENABLED='false'", async () => {
    const env = baseEnv({ HOUSE_AGENT_ENABLED: "false" });
    const kv = new InMemoryKv();
    let upstreamCalls = 0;
    const fetchImpl = (async () => {
      upstreamCalls++;
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    const events = await readNeutralEvents(res);

    expect(upstreamCalls).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]!["type"]).toBe("error");
    expect(events[0]!["kind"]).toBe("quota");
    expect(String(events[0]!["message"])).toContain("add your own key");
  });

  it("fails closed when the ANTHROPIC_KEY secret is missing", async () => {
    const env = baseEnv();
    delete (env as { ANTHROPIC_KEY?: string }).ANTHROPIC_KEY;
    const kv = new InMemoryKv();

    const res = await handleRequest(makeRequest(), env, { kv });
    const events = await readNeutralEvents(res);

    expect(events[0]!["kind"]).toBe("quota");
    expect(String(events[0]!["message"])).toContain("add your own key");
  });
});

describe("house-agent worker: IP rate limit (layer 2)", () => {
  it("trips after IP_RPM_LIMIT requests in the same minute from the same IP", async () => {
    const env = baseEnv({ IP_RPM_LIMIT: "3" });
    const kv = new InMemoryKv();
    // Frozen clock so both prod and CI hit the same minute bin.
    const now = () => new Date("2026-07-05T12:00:00Z");
    const fetchImpl = (async () => okAnthropicStream()) as unknown as typeof fetch;

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await handleRequest(makeRequest(), env, { kv, fetchImpl, now });
      const events = await readNeutralEvents(res);
      const first = events[0]!;
      results.push(first["type"] === "error" ? String(first["kind"]) : "ok");
    }
    // 3 succeed, then the 4th and 5th trip with kind:"quota".
    expect(results.slice(0, 3).every((r) => r === "ok")).toBe(true);
    expect(results.slice(3)).toEqual(["quota", "quota"]);
  });
});

describe("house-agent worker: daily budget (layer 1)", () => {
  it("mints a token on first request and returns it in X-AirSpice-Token", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const fetchImpl = (async () => okAnthropicStream()) as unknown as typeof fetch;

    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    expect(res.headers.get("x-airspice-token")).toBeTruthy();
    // Drain the stream so the on-finally usage debit runs.
    await readNeutralEvents(res);
  });

  it("debits the daily counter after the upstream reports usage", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const fetchImpl = (async () =>
      okAnthropicStream({ input_tokens: 200, output_tokens: 50 })) as unknown as typeof fetch;

    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    const events = await readNeutralEvents(res);
    expect(events.some((e) => e["type"] === "usage")).toBe(true);

    // Post-drain, the `day:` counter should carry the 250 tokens the upstream
    // reported (200 input + 50 output). Sum all day counters (there is only
    // one per test) so the assertion does not depend on the token nonce.
    let usedTotal = 0;
    for (const key of kv.keys()) {
      if (key.startsWith("day:")) usedTotal += kv.peek(key);
    }
    expect(usedTotal).toBe(250);
  });

  it("trips with a BYOK-upsell error once the budget is exhausted", async () => {
    const env = baseEnv({ DAILY_TOKEN_BUDGET: "100" });
    const kv = new InMemoryKv();
    // First request: upstream returns a big usage that blows the budget.
    const firstFetch = (async () =>
      okAnthropicStream({ input_tokens: 200, output_tokens: 50 })) as unknown as typeof fetch;
    const res1 = await handleRequest(makeRequest(), env, {
      kv,
      fetchImpl: firstFetch,
    });
    const token = res1.headers.get("x-airspice-token");
    await readNeutralEvents(res1); // drain to trigger the debit

    expect(token).toBeTruthy();

    // Second request WITH the same token: should be blocked.
    const noUpstreamCall = (async () => {
      throw new Error("upstream should not be called after budget exhausted");
    }) as unknown as typeof fetch;
    const res2 = await handleRequest(
      makeRequest({}, { "x-airspice-token": token! }),
      env,
      { kv, fetchImpl: noUpstreamCall, now: () => new Date() },
    );
    const events2 = await readNeutralEvents(res2);
    expect(events2[0]!["kind"]).toBe("quota");
    expect(String(events2[0]!["message"])).toContain("Daily budget exhausted");
  });
});

describe("house-agent worker: monthly USD cap (layer 3, global)", () => {
  it("fails closed once MONTHLY_USD_CAP_CENTS is reached", async () => {
    const env = baseEnv({ MONTHLY_USD_CAP_CENTS: "1" });
    const kv = new InMemoryKv();
    // Pre-populate the month counter above the cap.
    const now = new Date("2026-07-05T12:00:00Z");
    await kv.put(
      `spend:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
      "10",
    );
    const res = await handleRequest(makeRequest(), env, {
      kv,
      fetchImpl: (async () => okAnthropicStream()) as unknown as typeof fetch,
      now: () => now,
    });
    const events = await readNeutralEvents(res);
    expect(events[0]!["kind"]).toBe("quota");
    expect(String(events[0]!["message"])).toContain("add your own key");
  });
});

describe("house-agent worker: SSE translation (happy path)", () => {
  it("relays Anthropic text_delta + tool_use as neutral text-delta + tool-call", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const fetchImpl = (async () =>
      anthropicSseResponse([
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_x", name: "validate_design" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"design_path"' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ': "a.air.xml"}' },
        },
        { type: "content_block_stop", index: 1 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 100, output_tokens: 25 },
        },
        { type: "message_stop" },
      ])) as unknown as typeof fetch;

    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    const events = await readNeutralEvents(res);

    // Order: text-delta, text-delta, tool-call, usage, done.
    expect(events.map((e) => e["type"])).toEqual([
      "text-delta",
      "text-delta",
      "tool-call",
      "usage",
      "done",
    ]);
    expect(events[2]!["name"]).toBe("validate_design");
    expect(events[2]!["args"]).toEqual({ design_path: "a.air.xml" });
    expect(events[3]!["inputTokens"]).toBe(100);
    expect(events[4]!["stopReason"]).toBe("tool_use");
  });

  it("marks a truncated tool-call as malformed (invalid_json)", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const fetchImpl = (async () =>
      anthropicSseResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_y", name: "validate_design" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"design_path": "a' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
      ])) as unknown as typeof fetch;

    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    const events = await readNeutralEvents(res);
    const call = events.find((e) => e["type"] === "tool-call")!;
    expect(call["args"]).toBeNull();
    expect((call["malformed"] as Record<string, unknown>)["kind"]).toBe("invalid_json");
  });

  it("surfaces upstream non-200 as a neutral typed error", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const res = await handleRequest(makeRequest(), env, { kv, fetchImpl });
    const events = await readNeutralEvents(res);
    expect(events[0]!["kind"]).toBe("quota");
    expect(String(events[0]!["message"])).toContain("upstream returned 401");
  });
});

describe("house-agent worker: method + route", () => {
  it("rejects GET /v1/chat", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const res = await handleRequest(
      new Request("https://house.mock/v1/chat", { method: "GET" }),
      env,
      { kv },
    );
    const events = await readNeutralEvents(res);
    expect(events[0]!["kind"]).toBe("model");
  });

  it("rejects unknown paths", async () => {
    const env = baseEnv();
    const kv = new InMemoryKv();
    const res = await handleRequest(
      new Request("https://house.mock/v1/other", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      env,
      { kv },
    );
    const events = await readNeutralEvents(res);
    expect(events[0]!["kind"]).toBe("model");
  });
});

function okAnthropicStream(usage: { input_tokens?: number; output_tokens?: number } = {}): Response {
  return anthropicSseResponse([
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
    },
  ]);
}

// Beforeeach a fresh KV isn't shared. (Instantiated per-test above.)
beforeEach(() => {
  /* nothing global to reset */
});
