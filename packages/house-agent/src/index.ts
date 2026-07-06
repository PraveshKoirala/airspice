/**
 * House-agent Cloudflare Worker — PROTOTYPE (issue #20).
 *
 * Feature-flagged OFF (`HOUSE_AGENT_ENABLED = "false"` in wrangler.toml). This
 * PR does not deploy. See docs/house_agent_design.md for the full picture.
 *
 * What this file does (and, critically, does not do):
 *   DOES:   HTTP handler → kill-switch check → IP rate limit → mint/verify
 *           daily-budget token → check monthly cap → forward to upstream
 *           provider → translate the upstream SSE into our neutral AgentEvent
 *           stream → debit the day/month counters from the `usage` event.
 *   DOES NOT: execute tools, assemble prompts, hold conversation state,
 *             persist prompts/responses, or identify the user. Those live
 *             client-side (NORTH_STAR §"Zero-backend default"; the whole
 *             point of the lane).
 *
 * The mocked-fetch test suite (`tests/worker.test.ts`) exercises every gate
 * against an injected upstream Response, so `npm test` covers the wire
 * contract with zero network. Live Wrangler running is documented but not
 * required — the spend controls must be verified before that step.
 */

import {
  InMemoryKv,
  type KvLike,
  ipBucketId,
  ipRateLimitOk,
  increment,
  read,
} from "./budget.js";
import { mintToken, utcDay, verifyToken, type TokenPayload } from "./token.js";

/** The Worker's environment binding. Mirrors wrangler.toml + secrets. */
export interface Env {
  HOUSE_AGENT_ENABLED: string; // "true" | "false"
  DAILY_TOKEN_BUDGET: string; // integer
  IP_RPM_LIMIT: string; // integer
  MONTHLY_USD_CAP_CENTS: string; // integer
  UPSTREAM_MODEL: string;
  UPSTREAM_URL: string;
  ANTHROPIC_KEY?: string; // wrangler secret
  TOKEN_SIGNING_SECRET?: string; // wrangler secret
  BUDGET?: KvLike; // KV binding at deploy time
}

/** Overridable dependencies for tests. */
export interface WorkerDeps {
  kv?: KvLike;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Rough USD-cents cost estimate per (input, output) tokens on the Haiku tier. */
const HAIKU_INPUT_CENTS_PER_MTOK = 25; // $0.25 / MTok input
const HAIKU_OUTPUT_CENTS_PER_MTOK = 125; // $1.25 / MTok output
function costCentsFor(inputTokens: number, outputTokens: number): number {
  const cents =
    (inputTokens * HAIKU_INPUT_CENTS_PER_MTOK + outputTokens * HAIKU_OUTPUT_CENTS_PER_MTOK) /
    1_000_000;
  return Math.max(0, Math.round(cents));
}

/** Bare-minimum SSE writer: one JSON object per event, `data: … \n\n`. */
function sseEncode(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A canned error response with the neutral-error SSE, always fails closed. */
function errorStream(kind: string, message: string): Response {
  const body = sseEncode({ type: "error", kind, retryable: false, message });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** The Worker's exported fetch handler. */
export async function handleRequest(
  request: Request,
  env: Env,
  deps: WorkerDeps = {},
): Promise<Response> {
  const kv = deps.kv ?? env.BUDGET ?? new InMemoryKv();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = (deps.now ?? (() => new Date()))();

  if (request.method !== "POST") {
    return errorStream("model", "House agent expects POST /v1/chat.");
  }
  const url = new URL(request.url);
  if (url.pathname !== "/v1/chat") {
    return errorStream("model", "House agent unknown endpoint.");
  }

  // 1. Global kill switch.
  if (env.HOUSE_AGENT_ENABLED !== "true") {
    return errorStream(
      "quota",
      "House agent temporarily unavailable — add your own key in Settings to continue.",
    );
  }
  if (!env.ANTHROPIC_KEY || !env.TOKEN_SIGNING_SECRET) {
    // A deploy without the required secrets: fail closed rather than 500.
    return errorStream(
      "quota",
      "House agent not configured — add your own key in Settings to continue.",
    );
  }

  // 2. Monthly spend cap (global fail-closed).
  const monthKey = `spend:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthCents = await read(kv, monthKey);
  const monthCap = parseInt(env.MONTHLY_USD_CAP_CENTS, 10);
  if (Number.isFinite(monthCap) && monthCents >= monthCap) {
    return errorStream(
      "quota",
      "House agent temporarily unavailable — add your own key in Settings to continue.",
    );
  }

  // 3. Per-IP rate limit.
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const ipHash = await ipBucketId(ip, env.TOKEN_SIGNING_SECRET);
  const ipLimit = parseInt(env.IP_RPM_LIMIT, 10);
  const rate = await ipRateLimitOk(kv, ipHash, Number.isFinite(ipLimit) ? ipLimit : 30, now);
  if (!rate.ok) {
    return errorStream(
      "quota",
      "Too many house-agent requests from this network — slow down or add your own key in Settings.",
    );
  }

  // 4. Daily-budget token.
  const today = utcDay(now);
  const dailyBudget = parseInt(env.DAILY_TOKEN_BUDGET, 10);
  const sent = request.headers.get("x-airspice-token");
  let payload: TokenPayload | null = sent
    ? await verifyToken(env.TOKEN_SIGNING_SECRET, sent, today)
    : null;
  let mintedToken: string | null = null;
  if (!payload) {
    const minted = await mintToken(env.TOKEN_SIGNING_SECRET, today, dailyBudget);
    mintedToken = minted.token;
    payload = minted.payload;
  }
  const dayKey = `day:${payload.day}:${payload.nonce}`;
  const usedToday = await read(kv, dayKey);
  if (usedToday >= payload.budget) {
    return errorStream(
      "quota",
      "Daily budget exhausted — add your own key in Settings to continue.",
    );
  }

  // 5. Parse the client body. Enforce that the client cannot escalate the
  // model above the configured tier.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorStream("model", "House agent could not parse the request body.");
  }
  const requestedModel = typeof body["model"] === "string" ? (body["model"] as string) : "";
  // The Worker OWNS the model choice. Client hint is ignored unless it matches
  // the configured tier — no client can talk the Worker into a costlier model.
  const upstreamModel = env.UPSTREAM_MODEL;
  void requestedModel;

  // 6. Translate the neutral request body to Anthropic's Messages format.
  const anthropicBody = neutralToAnthropic(body, upstreamModel);

  // 7. Forward. Any upstream error surfaces as a neutral error event; the
  // client renders it verbatim (redaction is trivial here — the key is only
  // in the outbound headers we set ourselves).
  const upstream = await fetchImpl(env.UPSTREAM_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  if (!upstream.ok) {
    // Fail LOUD on upstream failures with a typed neutral error. The client
    // treats `kind: "quota"` as "surface the BYOK banner"; anything else is
    // rendered as a plain error toast.
    const status = upstream.status;
    const kind =
      status === 401 || status === 403
        ? "quota"
        : status === 429
          ? "quota"
          : status >= 500
            ? "network"
            : "model";
    return errorStream(
      kind,
      `House agent upstream returned ${status}. Add your own key in Settings if this persists.`,
    );
  }

  // 8. Stream translation. Every debit against the day/month counters happens
  // AFTER we see the upstream `usage` event, so we never charge a user for a
  // request that fell over mid-stream.
  const readable = translateAnthropicStream(upstream, async (u) => {
    if (u.total > 0) {
      await increment(kv, dayKey, u.total, 60 * 60 * 26);
      await increment(kv, monthKey, costCentsFor(u.input, u.output), 60 * 60 * 24 * 40);
    }
  });

  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
  };
  if (mintedToken) headers["x-airspice-token"] = mintedToken;
  return new Response(readable, { status: 200, headers });
}

interface UsageTotals {
  input: number;
  output: number;
  total: number;
}

/**
 * Convert our neutral `ChatRequest`-shaped body into Anthropic Messages format.
 * Kept minimal — this is a prototype, and the browser-side `AnthropicProvider`
 * already contains the full mapping (issue #17 / #101). If we bring this to
 * production the two mappings will share one implementation in `packages/agent`.
 */
function neutralToAnthropic(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  return {
    model,
    max_tokens: typeof body["maxTokens"] === "number" ? body["maxTokens"] : 1024,
    stream: true,
    system: typeof body["system"] === "string" ? body["system"] : "",
    tools: Array.isArray(body["tools"])
      ? body["tools"].map((t) => {
          const spec = t as Record<string, unknown>;
          return { name: spec["name"], description: spec["description"], input_schema: spec["parameters"] };
        })
      : [],
    messages: messages.map((m) => {
      const msg = m as Record<string, unknown>;
      if (msg["role"] === "tool") {
        return {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: msg["toolCallId"] ?? "", content: msg["content"] ?? "" },
          ],
        };
      }
      return { role: msg["role"], content: msg["content"] };
    }),
  };
}

/**
 * Translate Anthropic Messages streaming SSE into our neutral AgentEvent SSE,
 * calling `onUsage` once when the upstream reports its `usage` totals so the
 * caller can debit the counters.
 *
 * Kept intentionally simple: the browser-side `AnthropicProvider` (which we
 * would consolidate on before this ships live) contains the full reassembly.
 */
function translateAnthropicStream(
  upstream: Response,
  onUsage: (u: UsageTotals) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (event: unknown): void => {
        controller.enqueue(encoder.encode(sseEncode(event)));
      };
      const body = upstream.body;
      if (!body) {
        emit({ type: "done", stopReason: "stop" });
        controller.close();
        return;
      }
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      let stopReason: "stop" | "tool_use" | "max_tokens" | "aborted" = "stop";
      let totals: UsageTotals = { input: 0, output: 0, total: 0 };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trimEnd();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice("data:".length).trim();
            if (!data || data === "[DONE]") continue;
            let ev: Record<string, unknown>;
            try {
              ev = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }
            const type = ev["type"];
            if (type === "content_block_start") {
              const idx = typeof ev["index"] === "number" ? (ev["index"] as number) : -1;
              const block = ev["content_block"] as Record<string, unknown> | undefined;
              if (block && block["type"] === "tool_use" && idx >= 0) {
                toolBlocks.set(idx, {
                  id: String(block["id"] ?? `tool_${idx}`),
                  name: String(block["name"] ?? ""),
                  json: "",
                });
              }
            } else if (type === "content_block_delta") {
              const idx = typeof ev["index"] === "number" ? (ev["index"] as number) : -1;
              const delta = ev["delta"] as Record<string, unknown> | undefined;
              if (!delta) continue;
              if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
                emit({ type: "text-delta", text: delta["text"] });
              } else if (
                delta["type"] === "input_json_delta" &&
                typeof delta["partial_json"] === "string" &&
                idx >= 0
              ) {
                const block = toolBlocks.get(idx);
                if (block) block.json += delta["partial_json"];
              }
            } else if (type === "content_block_stop") {
              const idx = typeof ev["index"] === "number" ? (ev["index"] as number) : -1;
              const block = idx >= 0 ? toolBlocks.get(idx) : undefined;
              if (block) {
                let args: unknown = {};
                try {
                  args = JSON.parse(block.json);
                } catch {
                  args = null;
                }
                emit(
                  args === null
                    ? {
                        type: "tool-call",
                        id: block.id,
                        name: block.name,
                        args: null,
                        malformed: {
                          kind: "invalid_json",
                          rawArgs: block.json,
                          detail: "Upstream returned tool arguments that did not parse.",
                        },
                      }
                    : { type: "tool-call", id: block.id, name: block.name, args },
                );
                toolBlocks.delete(idx);
              }
            } else if (type === "message_delta") {
              const delta = ev["delta"] as Record<string, unknown> | undefined;
              const reason = delta?.["stop_reason"];
              if (typeof reason === "string") {
                if (reason === "tool_use") stopReason = "tool_use";
                else if (reason === "max_tokens") stopReason = "max_tokens";
                else stopReason = "stop";
              }
              const usage = ev["usage"] as Record<string, unknown> | undefined;
              if (usage) {
                const input = typeof usage["input_tokens"] === "number" ? (usage["input_tokens"] as number) : 0;
                const output = typeof usage["output_tokens"] === "number" ? (usage["output_tokens"] as number) : 0;
                totals = { input, output, total: input + output };
                emit({ type: "usage", inputTokens: input, outputTokens: output });
              }
            }
          }
        }
        emit({ type: "done", stopReason });
      } catch (err) {
        emit({ type: "error", kind: "network", retryable: false, message: `Upstream stream error: ${(err as Error).message}` });
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
        try {
          await onUsage(totals);
        } catch {
          /* debit failures are logged upstream in prod; not fatal to the stream */
        }
        controller.close();
      }
    },
  });
}

/** Cloudflare Workers module entry. Not touched by tests. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
