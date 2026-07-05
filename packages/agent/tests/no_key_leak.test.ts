import { describe, it, expect } from "vitest";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  redactKey,
  RedactedError,
  type AgentProvider,
} from "../src/index.js";
import { collect, errorResponse, fakeKey, makeRequest, stubFetch } from "./helpers.js";

// A distinctive, unmistakable secret. If ANY string produced by an error path
// contains this literal, the test fails. This is the grep-proof no-key-leak
// guarantee (issue #17 / AGENTS.md rule 15): keys never reach logs/errors.
// Assembled from parts so no single source line is itself a key-shaped literal
// (keeps guardrails R5 clean while the runtime value stays realistically shaped).
const SECRET = fakeKey("sk-ant-", "LEAKME0123456789abcdefghijklmnop");

function providersUnderTest(fetchImpl: typeof fetch): AgentProvider[] {
  return [
    new AnthropicProvider({ apiKey: SECRET, fetchImpl }),
    new OpenAIProvider({ apiKey: SECRET, fetchImpl }),
    new GeminiProvider({ apiKey: SECRET, fetchImpl }),
  ];
}

describe("no key leak in the error path", () => {
  it("redactKey removes the exact key and key-shaped tokens", () => {
    const text = `Authorization: Bearer ${SECRET} failed`;
    const out = redactKey(text, SECRET);
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts a key echoed back in a provider error BODY (unknown to us)", () => {
    // A provider error body echoing a *different* key-shaped token must still be
    // masked by the shape patterns even without knowing the exact value.
    const echoed = fakeKey("sk-ant-", "someOtherKeyThatLooksReal0123456789");
    const out = redactKey(`error: invalid key ${echoed}`, undefined);
    expect(out).not.toContain(echoed);
  });

  it("RedactedError.message never contains the key", () => {
    const err = new RedactedError({
      kind: "auth",
      retryable: false,
      message: `bad key ${SECRET}`,
      key: SECRET,
    });
    expect(err.message).not.toContain(SECRET);
    expect(err.toEvent().message).not.toContain(SECRET);
  });

  it("no provider leaks the key when the API 401s while echoing it", async () => {
    // Worst case: the provider's own 401 body contains the key. The error event
    // that surfaces to the app must not.
    const { fetchImpl } = stubFetch(() =>
      errorResponse(401, `Unauthorized: key ${SECRET} is invalid`),
    );
    for (const provider of providersUnderTest(fetchImpl)) {
      const events = await collect(provider.chat(makeRequest()));
      for (const ev of events) {
        const serialized = JSON.stringify(ev);
        expect(serialized).not.toContain(SECRET);
      }
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      expect(JSON.stringify(err)).not.toContain(SECRET);
    }
  });

  it("no provider leaks the key when a 500 body echoes it (retry-exhausted)", async () => {
    const { fetchImpl } = stubFetch(() =>
      errorResponse(500, `Internal error processing ${SECRET}`, { "retry-after": "0" }),
    );
    for (const provider of providersUnderTest(fetchImpl)) {
      const events = await collect(provider.chat(makeRequest()));
      for (const ev of events) {
        expect(JSON.stringify(ev)).not.toContain(SECRET);
      }
    }
  });

  it("validateKey never leaks the key in its detail on rejection", async () => {
    const { fetchImpl } = stubFetch(() =>
      errorResponse(418, `teapot rejected ${SECRET}`),
    );
    for (const provider of providersUnderTest(fetchImpl)) {
      const result = await provider.validateKey(SECRET);
      expect(result.detail).not.toContain(SECRET);
    }
  });

  it("validateKey never leaks the key when the network throws", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error(`connection to host with ${SECRET} refused`);
    });
    for (const provider of providersUnderTest(fetchImpl)) {
      const result = await provider.validateKey(SECRET);
      expect(result.detail).not.toContain(SECRET);
    }
  });
});
