/**
 * HouseProvider (issue #20): the browser-side client that talks to the
 * hosted house-agent Worker. Feature-flagged OFF in production builds.
 *
 * These tests exercise the client contract against a mocked Worker (no
 * network): a happy-path relay of neutral events, a quota error surfacing
 * the BYOK upsell text verbatim, the fail-closed construction when no URL
 * is configured, and the token-cache round trip.
 */

import { describe, it, expect } from "vitest";
import { HouseProvider, type AgentEvent } from "../src/index.js";
import { collect, joinText, makeRequest, sseEvents, stubFetch, toolCalls } from "./helpers.js";

const URL = "https://house.mock";

function memoryTokenStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void; dump: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    dump: map,
  };
}

describe("HouseProvider: construction", () => {
  it("refuses to construct without a URL (fail-closed)", () => {
    expect(() => new HouseProvider({ houseAgentUrl: "" })).toThrow(/not configured/);
  });

  it("trims trailing slashes on the URL", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      sseEvents([{ type: "done", stopReason: "stop" }]),
    );
    const provider = new HouseProvider({
      houseAgentUrl: `${URL}/`,
      fetchImpl,
      tokenStorage: memoryTokenStorage(),
    });
    await collect(provider.chat(makeRequest()));
    expect(calls[0]!.url).toBe(`${URL}/v1/chat`);
  });

  it("validateKey returns an ok-noop (nothing to validate on the house lane)", async () => {
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl: (async () => new Response("nope")) as unknown as typeof fetch,
      tokenStorage: memoryTokenStorage(),
    });
    const result = await provider.validateKey("");
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("nothing to validate");
  });
});

describe("HouseProvider: neutral-event stream", () => {
  it("relays text-delta + tool-call + usage + done from the Worker", async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      sseEvents([
        { type: "text-delta", text: "Hello, " },
        { type: "text-delta", text: "world." },
        {
          type: "tool-call",
          id: "toolu_x",
          name: "validate_design",
          args: { design_path: "a.air.xml" },
        },
        { type: "usage", inputTokens: 100, outputTokens: 25 },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl,
      tokenStorage: memoryTokenStorage(),
    });
    const events = await collect(provider.chat(makeRequest()));

    expect(joinText(events)).toBe("Hello, world.");
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.args).toEqual({ design_path: "a.air.xml" });
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 100)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });

    // POST /v1/chat with a JSON body — the Worker owns the model + key.
    expect(calls[0]!.url).toBe(`${URL}/v1/chat`);
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    // No API key headers on this lane — the Worker carries the key.
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
  });

  it("caches the Worker's X-AirSpice-Token for the next request", async () => {
    let responseCallIdx = 0;
    const tokenStorage = memoryTokenStorage();
    const { fetchImpl, calls } = stubFetch(() => {
      responseCallIdx++;
      const events: AgentEvent[] = [{ type: "done", stopReason: "stop" }];
      const response = sseEvents(events);
      if (responseCallIdx === 1) {
        response.headers.set("X-AirSpice-Token", "signed.token.value");
      }
      return response;
    });
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl,
      tokenStorage,
    });

    // First call: no token sent (no cache); Worker mints and returns one.
    await collect(provider.chat(makeRequest()));
    const first = calls[0]!.init!.headers as Record<string, string>;
    expect(first["x-airspice-token"]).toBeUndefined();
    expect(tokenStorage.dump.get("airspice.house-agent.token")).toBe("signed.token.value");

    // Second call: the cached token is sent.
    await collect(provider.chat(makeRequest()));
    const second = calls[1]!.init!.headers as Record<string, string>;
    expect(second["x-airspice-token"]).toBe("signed.token.value");
  });

  it("surfaces the Worker's quota error verbatim (BYOK upsell path)", async () => {
    const { fetchImpl } = stubFetch(() =>
      sseEvents([
        {
          type: "error",
          kind: "quota",
          retryable: false,
          message: "Daily budget exhausted — add your own key in Settings to continue.",
        },
      ]),
    );
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl,
      tokenStorage: memoryTokenStorage(),
    });
    const events = await collect(provider.chat(makeRequest()));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(err!).toMatchObject({
      type: "error",
      kind: "quota",
      retryable: false,
    });
    expect((err as { message: string }).message).toContain("add your own key");
  });

  it("re-validates malformed tool-call args through the recovery ladder", async () => {
    // The Worker forwards a call with a malformed rawArgs; the client re-runs
    // it through parseToolArgs against the request's tools and preserves the
    // malformed marker (defensive: a Worker bug can never inject a valid-
    // looking call that skips validation).
    const { fetchImpl } = stubFetch(() =>
      sseEvents([
        {
          type: "tool-call",
          id: "toolu_bad",
          name: "validate_design",
          args: null,
          malformed: {
            kind: "invalid_json",
            rawArgs: '{"design_path": "a',
            detail: "Upstream returned tool arguments that did not parse.",
          },
        },
        { type: "done", stopReason: "tool_use" },
      ]),
    );
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl,
      tokenStorage: memoryTokenStorage(),
    });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.args).toBeNull();
    expect(tc[0]!.malformed?.kind).toBe("invalid_json");
  });

  it("synthesizes a terminal error if the Worker stream ends without done/error", async () => {
    const { fetchImpl } = stubFetch(() =>
      sseEvents([{ type: "text-delta", text: "partial" }]),
    );
    const provider = new HouseProvider({
      houseAgentUrl: URL,
      fetchImpl,
      tokenStorage: memoryTokenStorage(),
    });
    const events = await collect(provider.chat(makeRequest()));
    const err = events.at(-1);
    expect(err?.type).toBe("error");
    expect((err as { kind: string }).kind).toBe("network");
  });
});
