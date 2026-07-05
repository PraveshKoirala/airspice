import { describe, it, expect } from "vitest";
import { GeminiProvider } from "../src/index.js";
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

const KEY = fakeKey("AIza", "SyGeminiSecretKeyABCDEFGHIJKLMNOP");

function geminiTextStream(): Response {
  return sseEvents([
    { candidates: [{ content: { role: "model", parts: [{ text: "Rail " }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "ready." }] }, finishReason: "STOP" }] },
    { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 7 } },
  ]);
}

function geminiToolStream(): Response {
  return sseEvents([
    { candidates: [{ content: { role: "model", parts: [{ text: "Validating. " }] } }] },
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "validate_design", args: { design_path: "c.air.xml" } } }],
          },
        },
      ],
    },
    { usageMetadata: { promptTokenCount: 45, candidatesTokenCount: 11 } },
  ]);
}

describe("GeminiProvider", () => {
  it("reassembles streamed text (happy path)", async () => {
    const { fetchImpl, calls } = stubFetch(() => geminiTextStream());
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(joinText(events)).toBe("Rail ready.");
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "stop" });
    expect(events.some((e) => e.type === "usage" && e.outputTokens === 7)).toBe(true);

    // Direct call to the generativelanguage endpoint; key is a query param.
    expect(calls[0]!.url).toContain(
      "generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent",
    );
    expect(calls[0]!.url).toContain("alt=sse");
  });

  it("parses a single-part functionCall and sets stopReason=tool_use", async () => {
    const { fetchImpl } = stubFetch(() => geminiToolStream());
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events);
    expect(tc).toHaveLength(1);
    expect(tc[0]!.name).toBe("validate_design");
    expect(tc[0]!.args).toEqual({ design_path: "c.air.xml" });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("retries on 503 then succeeds", async () => {
    let n = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      n++;
      return n === 1 ? errorResponse(503, "unavailable") : geminiTextStream();
    });
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl, retry: FAST_RETRY });
    const events = await collect(provider.chat(makeRequest()));
    expect(calls).toHaveLength(2);
    expect(joinText(events)).toBe("Rail ready.");
  });

  it("surfaces a 400 as a non-retryable model error", async () => {
    const { fetchImpl, calls } = stubFetch(() => errorResponse(400, "bad request"));
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    expect(calls).toHaveLength(1);
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "model", retryable: false });
  });

  it("flags a functionCall with a schema-violating arg as malformed", async () => {
    const stream = sseEvents([
      {
        candidates: [
          {
            content: {
              role: "model",
              // design_path should be a string; number violates the schema.
              parts: [{ functionCall: { name: "validate_design", args: { design_path: 5 } } }],
            },
          },
        ],
      },
    ]);
    const { fetchImpl } = stubFetch(() => stream);
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest()));
    const tc = toolCalls(events)[0]!;
    expect(tc.args).toBeNull();
    expect(tc.malformed?.kind).toBe("schema_mismatch");
  });

  it("propagates AbortSignal (aborts before request)", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = stubFetch(() => geminiTextStream());
    const provider = new GeminiProvider({ apiKey: KEY, fetchImpl });
    const events = await collect(provider.chat(makeRequest({ signal: controller.signal })));
    expect(calls).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", kind: "aborted" });
  });
});
