/**
 * Anthropic provider (issue #17): direct browser calls to `/v1/messages`,
 * streaming (SSE), native tool use.
 *
 * CORS: Anthropic documents a browser opt-in via the
 * `anthropic-dangerous-direct-browser-access: true` header, which we set. There
 * is NO relay/proxy (ADR 0008): the request goes straight from the browser to
 * `api.anthropic.com`. The key travels only in this direct call.
 *
 * Streaming event model (Anthropic Messages streaming):
 *   message_start -> content_block_start(text|tool_use) ->
 *   content_block_delta(text_delta|input_json_delta) -> content_block_stop ->
 *   message_delta(stop_reason, usage) -> message_stop.
 * Tool-call arguments arrive as a stream of `input_json_delta` partial-JSON
 * fragments that we accumulate per content block and parse at content_block_stop
 * (or message_stop) through the shared recovery ladder.
 */

import { DEFAULT_BACKOFF, fetchWithRetry, readSSE, type BackoffConfig } from "../http.js";
import { RedactedError, redactKey } from "../redact.js";
import { parseToolArgs } from "../repair.js";
import { MODEL_CATALOG } from "../models.js";
import type {
  AgentEvent,
  AgentProvider,
  ChatRequest,
  ProviderOptions,
  ToolCallEvent,
  ValidateKeyResult,
} from "../types.js";

const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export class AnthropicProvider implements AgentProvider {
  readonly id = "anthropic" as const;
  readonly models = MODEL_CATALOG.anthropic.models;
  readonly defaultModel = MODEL_CATALOG.anthropic.defaultModel;

  private readonly key: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: BackoffConfig;
  private readonly baseUrl: string;

  constructor(opts: ProviderOptions) {
    this.key = opts.apiKey;
    this.model = opts.model ?? this.defaultModel;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.backoff = opts.retry ?? DEFAULT_BACKOFF;
    let base = opts.baseUrl ?? DEFAULT_API_URL;
    if (opts.baseUrl && !opts.baseUrl.endsWith("/messages")) {
      base = base.replace(/\/+$/, "") + "/messages";
    }
    this.baseUrl = base;
  }

  private headers(key = this.key): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": API_VERSION,
      // Documented CORS opt-in for direct browser calls (ADR 0008). No relay.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  async validateKey(key: string): Promise<ValidateKeyResult> {
    // A minimal 1-token request: a 200/ok body proves the key works; a 401/403
    // proves it does not. Any other status is reported as an inconclusive error
    // (never leaking the key).
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (response.ok) return { ok: true, detail: "Key accepted by Anthropic." };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: "Anthropic rejected this key (unauthorized)." };
      }
      const body = redactKey(await safeText(response), key);
      return {
        ok: false,
        detail: `Anthropic returned ${response.status}: ${body}`.trim(),
      };
    } catch (err) {
      return {
        ok: false,
        detail: redactKey(`Could not reach Anthropic: ${(err as Error).message}`, key),
      };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const body = buildRequestBody(this.model, req);
    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          this.fetchImpl(this.baseUrl, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
            signal: req.signal,
          }),
        req.signal,
        this.key,
        this.backoff,
      );
    } catch (err) {
      yield asErrorEvent(err, this.key);
      return;
    }

    yield* this.stream(response, req);
  }

  private async *stream(
    response: Response,
    req: ChatRequest,
  ): AsyncGenerator<AgentEvent> {
    // Per-content-block accumulators for streamed tool_use argument JSON.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason: "stop" | "tool_use" | "max_tokens" | "aborted" = "stop";
    let usageEmitted = false;

    try {
      for await (const data of readSSE(response, req.signal)) {
        const event = parseJson(data);
        if (!event || typeof event !== "object") continue;
        const type = (event as { type?: unknown }).type;

        if (type === "content_block_start") {
          const idx = numberField(event, "index");
          const block = (event as { content_block?: unknown }).content_block as
            | Record<string, unknown>
            | undefined;
          if (block && block["type"] === "tool_use" && idx !== null) {
            toolBlocks.set(idx, {
              id: String(block["id"] ?? `tool_${idx}`),
              name: String(block["name"] ?? ""),
              json: "",
            });
          }
        } else if (type === "content_block_delta") {
          const idx = numberField(event, "index");
          const delta = (event as { delta?: unknown }).delta as
            | Record<string, unknown>
            | undefined;
          if (!delta) continue;
          if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
            yield { type: "text-delta", text: delta["text"] };
          } else if (
            delta["type"] === "input_json_delta" &&
            typeof delta["partial_json"] === "string" &&
            idx !== null
          ) {
            const block = toolBlocks.get(idx);
            if (block) block.json += delta["partial_json"];
          }
        } else if (type === "content_block_stop") {
          const idx = numberField(event, "index");
          if (idx !== null && toolBlocks.has(idx)) {
            yield finalizeToolCall(toolBlocks.get(idx)!, req);
            toolBlocks.delete(idx);
          }
        } else if (type === "message_delta") {
          const delta = (event as { delta?: unknown }).delta as
            | Record<string, unknown>
            | undefined;
          const reason = delta?.["stop_reason"];
          if (typeof reason === "string") stopReason = mapStopReason(reason);
          const usage = (event as { usage?: unknown }).usage as
            | Record<string, unknown>
            | undefined;
          if (usage && !usageEmitted) {
            usageEmitted = true;
            yield {
              type: "usage",
              inputTokens: numberField({ v: usage["input_tokens"] }, "v") ?? 0,
              outputTokens: numberField({ v: usage["output_tokens"] }, "v") ?? 0,
            };
          }
        } else if (type === "error") {
          const errObj = (event as { error?: unknown }).error as
            | Record<string, unknown>
            | undefined;
          const message = redactKey(
            String(errObj?.["message"] ?? "Anthropic stream error"),
            this.key,
          );
          yield { type: "error", kind: "model", retryable: false, message };
          return;
        }
      }
    } catch (err) {
      yield asErrorEvent(err, this.key);
      return;
    }

    if (req.signal.aborted) stopReason = "aborted";
    // Flush any tool block that never received an explicit stop.
    for (const block of toolBlocks.values()) {
      yield finalizeToolCall(block, req);
    }
    yield { type: "done", stopReason };
  }
}

function buildRequestBody(model: string, req: ChatRequest): Record<string, unknown> {
  return {
    model,
    max_tokens: req.maxTokens,
    stream: true,
    system: req.system,
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
    messages: req.messages.map((m) => {
      if (m.role === "tool") {
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId ?? "",
              content: m.content,
            },
          ],
        };
      }
      // An assistant turn that made tool calls (issue #101) must re-emit its
      // tool_use blocks so the following tool_result blocks reference valid ids.
      // Anthropic wants a content ARRAY: optional leading text, then one
      // `tool_use` block per call (input = parsed args; `{}` for a malformed
      // call whose args did not parse but whose id must still round-trip).
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const content: Record<string, unknown>[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const call of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.args ?? {},
          });
        }
        return { role: "assistant", content };
      }
      return { role: m.role, content: m.content };
    }),
  };
}

function finalizeToolCall(
  block: { id: string; name: string; json: string },
  req: ChatRequest,
): ToolCallEvent {
  const parsed = parseToolArgs(block.name, block.json, req.tools);
  if (parsed.ok) {
    return { type: "tool-call", id: block.id, name: block.name, args: parsed.args };
  }
  return {
    type: "tool-call",
    id: block.id,
    name: block.name,
    args: null,
    malformed: parsed.malformed!,
  };
}

function mapStopReason(reason: string): "stop" | "tool_use" | "max_tokens" | "aborted" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "stop";
}

function asErrorEvent(err: unknown, key: string): AgentEvent {
  if (err instanceof RedactedError) return err.toEvent();
  return {
    type: "error",
    kind: "network",
    retryable: false,
    message: redactKey(`Unexpected error: ${(err as Error).message}`, key),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberField(obj: unknown, key: string): number | null {
  if (obj && typeof obj === "object") {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
