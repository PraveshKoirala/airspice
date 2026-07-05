/**
 * OpenAI provider (issue #17): direct browser calls to chat completions with
 * `tools`, streaming (SSE). No relay (ADR 0008); the key travels only in this
 * direct call as the Bearer token.
 *
 * Streaming tool calls: each SSE chunk carries `choices[0].delta`. Text arrives
 * as `delta.content`. Tool calls arrive as `delta.tool_calls[]`, each with an
 * `index`; the first fragment for an index carries `id` + `function.name`, and
 * subsequent fragments append `function.arguments` (partial JSON). We accumulate
 * per index and finalize when the stream reports `finish_reason` (or ends),
 * parsing arguments through the shared recovery ladder.
 *
 * CORS: OpenAI's API does not send permissive CORS headers for browser origins
 * on all deployments; direct browser use is best-effort and may be blocked
 * depending on the account/gateway. Per the guardrails we do NOT stand up a
 * relay -- a CORS block surfaces as a typed `network` error and is documented in
 * the PR's provider matrix.
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

const API_URL = "https://api.openai.com/v1/chat/completions";

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

export class OpenAIProvider implements AgentProvider {
  readonly id = "openai" as const;
  readonly models = MODEL_CATALOG.openai.models;
  readonly defaultModel = MODEL_CATALOG.openai.defaultModel;

  private readonly key: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: BackoffConfig;

  constructor(opts: ProviderOptions) {
    this.key = opts.apiKey;
    this.model = opts.model ?? this.defaultModel;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.backoff = opts.retry ?? DEFAULT_BACKOFF;
  }

  private headers(key = this.key): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    };
  }

  async validateKey(key: string): Promise<ValidateKeyResult> {
    // GET /v1/models is the cheapest authenticated probe: 200 => key works,
    // 401 => bad key. Never echoes the key.
    try {
      const response = await this.fetchImpl("https://api.openai.com/v1/models", {
        method: "GET",
        headers: { authorization: `Bearer ${key}` },
      });
      if (response.ok) return { ok: true, detail: "Key accepted by OpenAI." };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: "OpenAI rejected this key (unauthorized)." };
      }
      const body = redactKey(await safeText(response), key);
      return { ok: false, detail: `OpenAI returned ${response.status}: ${body}`.trim() };
    } catch (err) {
      return {
        ok: false,
        detail: redactKey(`Could not reach OpenAI: ${(err as Error).message}`, key),
      };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const body = buildRequestBody(this.model, req);
    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          this.fetchImpl(API_URL, {
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
    const tools = new Map<number, ToolAccumulator>();
    let stopReason: "stop" | "tool_use" | "max_tokens" | "aborted" = "stop";
    let usageEmitted = false;

    try {
      for await (const data of readSSE(response, req.signal)) {
        const chunk = parseJson(data);
        if (!chunk || typeof chunk !== "object") continue;

        const usage = (chunk as { usage?: unknown }).usage as
          | Record<string, unknown>
          | undefined;
        if (usage && !usageEmitted) {
          usageEmitted = true;
          yield {
            type: "usage",
            inputTokens: num(usage["prompt_tokens"]),
            outputTokens: num(usage["completion_tokens"]),
          };
        }

        const choice = firstChoice(chunk);
        if (!choice) continue;

        const delta = choice["delta"] as Record<string, unknown> | undefined;
        if (delta) {
          if (typeof delta["content"] === "string" && delta["content"] !== "") {
            yield { type: "text-delta", text: delta["content"] };
          }
          const toolCalls = delta["tool_calls"];
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              accumulateToolCall(tools, tc as Record<string, unknown>);
            }
          }
        }

        const finish = choice["finish_reason"];
        if (typeof finish === "string" && finish !== "null") {
          if (finish === "tool_calls") stopReason = "tool_use";
          else if (finish === "length") stopReason = "max_tokens";
          else stopReason = "stop";
        }
      }
    } catch (err) {
      yield asErrorEvent(err, this.key);
      return;
    }

    // Emit accumulated tool calls in index order (determinism).
    for (const idx of [...tools.keys()].sort((a, b) => a - b)) {
      yield finalizeToolCall(tools.get(idx)!, req);
    }
    if (req.signal.aborted) stopReason = "aborted";
    yield { type: "done", stopReason };
  }
}

function accumulateToolCall(
  tools: Map<number, ToolAccumulator>,
  tc: Record<string, unknown>,
): void {
  const index = typeof tc["index"] === "number" ? tc["index"] : 0;
  const existing = tools.get(index) ?? { id: "", name: "", args: "" };
  if (typeof tc["id"] === "string" && tc["id"]) existing.id = tc["id"];
  const fn = tc["function"] as Record<string, unknown> | undefined;
  if (fn) {
    if (typeof fn["name"] === "string" && fn["name"]) existing.name = fn["name"];
    if (typeof fn["arguments"] === "string") existing.args += fn["arguments"];
  }
  tools.set(index, existing);
}

function finalizeToolCall(acc: ToolAccumulator, req: ChatRequest): ToolCallEvent {
  const id = acc.id || `tool_${acc.name}`;
  const parsed = parseToolArgs(acc.name, acc.args, req.tools);
  if (parsed.ok) {
    return { type: "tool-call", id, name: acc.name, args: parsed.args };
  }
  return {
    type: "tool-call",
    id,
    name: acc.name,
    args: null,
    malformed: parsed.malformed!,
  };
}

function buildRequestBody(model: string, req: ChatRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (m.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        content: m.content,
      });
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // An assistant turn that called tools (issue #101) must carry a
      // `tool_calls[]` array so the following `tool`-role messages (keyed by
      // tool_call_id) have a preceding message to answer — OpenAI 400s on a
      // `tool` message that does not follow an assistant `tool_calls`. Arguments
      // are re-stringified JSON (`{}` for a malformed call whose args did not
      // parse but whose id must still round-trip). `content` is null when the
      // turn was tool-only (OpenAI allows null content alongside tool_calls).
      messages.push({
        role: "assistant",
        content: m.content ? m.content : null,
        tool_calls: m.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          },
        })),
      });
    } else {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return {
    model,
    max_tokens: req.maxTokens,
    stream: true,
    // Ask for usage in the final streamed chunk.
    stream_options: { include_usage: true },
    messages,
    tools: req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
  };
}

function firstChoice(chunk: unknown): Record<string, unknown> | null {
  const choices = (chunk as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    return choices[0] as Record<string, unknown>;
  }
  return null;
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

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
