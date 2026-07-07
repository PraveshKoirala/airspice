/**
 * Gemini provider (issue #17): direct browser calls to
 * `generativelanguage.googleapis.com`, `streamGenerateContent` (SSE) with
 * function calling. No relay (ADR 0008); the key travels only in this direct
 * call, passed as the `?key=` query param per the Generative Language API.
 *
 * Tool schemas: Gemini's `functionDeclarations` take the same
 * name/description/parameters(JSON-Schema) shape as our neutral `ToolSpec`,
 * which is exactly the reuse the issue asks for ("reuse tool schemas from
 * agent.py's Gemini integration").
 *
 * Streaming: with `?alt=sse` Gemini emits SSE `data:` lines, each a full
 * `GenerateContentResponse` JSON. Unlike Anthropic/OpenAI, a Gemini functionCall
 * arrives as a COMPLETE object in one part (args already a JSON object), so there
 * is no cross-chunk argument accumulation -- we still route it through the shared
 * recovery ladder (re-stringify + parse) so validation is identical across
 * providers.
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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiProvider implements AgentProvider {
  readonly id = "gemini" as const;
  readonly models = MODEL_CATALOG.gemini.models;
  readonly defaultModel = MODEL_CATALOG.gemini.defaultModel;

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
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  }

  async validateKey(key: string): Promise<ValidateKeyResult> {
    // GET the model metadata: 200 => key works, 400/403 => bad/again key. The
    // key is a query param, so it is never placed in a header we might log; and
    // any echoed body is scrubbed.
    let base = this.baseUrl;
    if (!base.endsWith("/models") && base === DEFAULT_BASE_URL) {
       // if custom baseurl does not end in models, leave it, just append the model name.
    }
    const url = `${base}/${encodeURIComponent(this.model)}?key=${encodeURIComponent(key)}`;
    try {
      const response = await this.fetchImpl(url, { method: "GET" });
      if (response.ok) return { ok: true, detail: "Key accepted by Gemini." };
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { ok: false, detail: "Gemini rejected this key (unauthorized)." };
      }
      const body = redactKey(await safeText(response), key);
      return { ok: false, detail: `Gemini returned ${response.status}: ${body}`.trim() };
    } catch (err) {
      return {
        ok: false,
        detail: redactKey(`Could not reach Gemini: ${(err as Error).message}`, key),
      };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const url =
      `${this.baseUrl}/${encodeURIComponent(this.model)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(this.key)}`;
    const body = buildRequestBody(req);
    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          this.fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
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
    let stopReason: "stop" | "tool_use" | "max_tokens" | "aborted" = "stop";
    let sawToolCall = false;
    let usageEmitted = false;
    let toolIndex = 0;

    try {
      for await (const data of readSSE(response, req.signal)) {
        const obj = parseJson(data);
        if (!obj || typeof obj !== "object") continue;

        const candidates = (obj as { candidates?: unknown }).candidates;
        if (Array.isArray(candidates) && candidates.length > 0) {
          const candidate = candidates[0] as Record<string, unknown>;
          const content = candidate["content"] as Record<string, unknown> | undefined;
          const parts = content?.["parts"];
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const p = part as Record<string, unknown>;
              if (typeof p["text"] === "string" && p["text"] !== "") {
                yield { type: "text-delta", text: p["text"] };
              } else if (p["functionCall"] && typeof p["functionCall"] === "object") {
                sawToolCall = true;
                yield finalizeFunctionCall(
                  p["functionCall"] as Record<string, unknown>,
                  toolIndex++,
                  req,
                );
              }
            }
          }
          const finish = candidate["finishReason"];
          if (typeof finish === "string") {
            if (finish === "MAX_TOKENS") stopReason = "max_tokens";
          }
        }

        const usage = (obj as { usageMetadata?: unknown }).usageMetadata as
          | Record<string, unknown>
          | undefined;
        if (usage && !usageEmitted) {
          usageEmitted = true;
          yield {
            type: "usage",
            inputTokens: num(usage["promptTokenCount"]),
            outputTokens: num(usage["candidatesTokenCount"]),
          };
        }
      }
    } catch (err) {
      yield asErrorEvent(err, this.key);
      return;
    }

    if (sawToolCall && stopReason === "stop") stopReason = "tool_use";
    if (req.signal.aborted) stopReason = "aborted";
    yield { type: "done", stopReason };
  }
}

function finalizeFunctionCall(
  fc: Record<string, unknown>,
  index: number,
  req: ChatRequest,
): ToolCallEvent {
  const name = String(fc["name"] ?? "");
  const argsObj = fc["args"];
  // Gemini gives args as an already-parsed object; re-stringify so the shared
  // ladder validates it identically to the streamed-JSON providers.
  const rawArgs =
    argsObj !== undefined && argsObj !== null ? JSON.stringify(argsObj) : "";
  const id = `gemini_${name}_${index}`;
  const parsed = parseToolArgs(name, rawArgs, req.tools);
  if (parsed.ok) {
    return { type: "tool-call", id, name, args: parsed.args };
  }
  return { type: "tool-call", id, name, args: null, malformed: parsed.malformed! };
}

function buildRequestBody(req: ChatRequest): Record<string, unknown> {
  const contents = req.messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? "tool",
              response: { content: m.content },
            },
          },
        ],
      };
    }
    // An assistant (`model`) turn that called tools (issue #101) must re-emit its
    // `functionCall` parts so the following `functionResponse` parts have the
    // matching calls to answer. Gemini correlates a functionResponse to its
    // functionCall by NAME + order, so we emit one functionCall part per call in
    // order (optional leading text part first). `args` is the parsed object
    // (`{}` for a malformed call whose args did not parse).
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.args ?? {} } });
      }
      return { role: "model", parts };
    }
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    };
  });

  const bodyBase: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents,
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
  if (req.tools.length > 0) {
    bodyBase["tools"] = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  return bodyBase;
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
