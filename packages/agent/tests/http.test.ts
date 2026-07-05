import { describe, it, expect } from "vitest";
import { classifyStatus } from "../src/index.js";
import { fetchWithRetry, abortableSleep, readSSE } from "../src/http.js";
import { RedactedError } from "../src/redact.js";
import { errorResponse, sseResponse } from "./helpers.js";

describe("classifyStatus taxonomy", () => {
  it("maps statuses to (kind, retryable)", () => {
    expect(classifyStatus(401)).toEqual({ kind: "auth", retryable: false });
    expect(classifyStatus(403)).toEqual({ kind: "auth", retryable: false });
    expect(classifyStatus(429)).toEqual({ kind: "quota", retryable: true });
    expect(classifyStatus(500)).toEqual({ kind: "network", retryable: true });
    expect(classifyStatus(503)).toEqual({ kind: "network", retryable: true });
    expect(classifyStatus(400)).toEqual({ kind: "model", retryable: false });
    expect(classifyStatus(404)).toEqual({ kind: "model", retryable: false });
    expect(classifyStatus(418)).toEqual({ kind: "model", retryable: false });
  });
});

describe("fetchWithRetry", () => {
  // A no-op sleep records the requested delays so we can assert exponential
  // backoff without real timers (deterministic + fast).
  function recordingSleep() {
    const delays: number[] = [];
    return {
      delays,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    };
  }

  it("uses exponential backoff on repeated 500s (500, 1000, 2000)", async () => {
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchWithRetry(
        async () => {
          calls++;
          return errorResponse(500, "boom");
        },
        controller.signal,
        "sk-key",
        { maxRetries: 3, baseDelayMs: 500, sleep },
      ),
    ).rejects.toBeInstanceOf(RedactedError);
    expect(calls).toBe(4); // 1 + 3 retries
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("honours Retry-After header (seconds) over exponential", async () => {
    const { delays, sleep } = recordingSleep();
    const controller = new AbortController();
    let calls = 0;
    await fetchWithRetry(
      async () => {
        calls++;
        return calls === 1
          ? errorResponse(429, "wait", { "retry-after": "2" })
          : new Response("ok", { status: 200 });
      },
      controller.signal,
      undefined,
      { maxRetries: 3, baseDelayMs: 500, sleep },
    );
    expect(delays).toEqual([2000]);
  });

  it("does not retry a non-retryable 401", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchWithRetry(
        async () => {
          calls++;
          return errorResponse(401, "nope");
        },
        controller.signal,
        undefined,
      ),
    ).rejects.toMatchObject({ kind: "auth", retryable: false });
    expect(calls).toBe(1);
  });

  it("treats a fetch throw as a retryable network error", async () => {
    const { sleep } = recordingSleep();
    const controller = new AbortController();
    let calls = 0;
    await expect(
      fetchWithRetry(
        async () => {
          calls++;
          throw new TypeError("Failed to fetch");
        },
        controller.signal,
        undefined,
        { maxRetries: 2, baseDelayMs: 10, sleep },
      ),
    ).rejects.toMatchObject({ kind: "network" });
    expect(calls).toBe(3);
  });

  it("aborts immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      fetchWithRetry(
        async () => {
          calls++;
          return new Response("ok", { status: 200 });
        },
        controller.signal,
        undefined,
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toBe(0);
  });
});

describe("abortableSleep", () => {
  it("rejects with AbortError when the signal fires mid-sleep", async () => {
    const controller = new AbortController();
    const p = abortableSleep(10_000, controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("readSSE", () => {
  it("stops at the [DONE] sentinel", async () => {
    const controller = new AbortController();
    const res = sseResponse(["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n", "data: c\n\n"]);
    const out: string[] = [];
    for await (const d of readSSE(res, controller.signal)) out.push(d);
    expect(out).toEqual(["a", "b"]);
  });
});
