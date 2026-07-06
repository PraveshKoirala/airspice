/**
 * House-agent provider (issue #20).
 *
 * The house agent is the ONE intentional server-side lane in an otherwise
 * zero-backend architecture (ADR 0008 / NORTH_STAR §"Cost model"): a keyless
 * user's request goes to our edge Worker, which carries OUR provider key,
 * meters a hard daily/monthly budget, and forwards to the upstream provider.
 *
 * Why this is a `provider` and not a bypass:
 *   The client treats the Worker like any other AgentProvider — it takes a
 *   `ChatRequest`, yields the same neutral `AgentEvent` stream. The tool
 *   runtime (#18), the repair loop (#19), and the deterministic gate (#96) all
 *   sit downstream, unchanged. This provider transports events; it does NOT
 *   execute tools, it does NOT reassemble prompts, and it does NOT hold state.
 *   Growing this class beyond that is a NORTH_STAR violation.
 *
 * Feature-flagged OFF in production (`VITE_ENABLE_HOUSE_AGENT=false` by
 * default). Even when compiled in, the provider REFUSES to construct if no
 * `houseAgentUrl` is supplied — so a mis-configured build lands on a clear
 * "not configured" error, never accidentally on a live endpoint.
 *
 * Wire format (documented verbatim in `docs/house_agent_design.md`):
 *   POST <url>/v1/chat
 *     Content-Type: application/json
 *     X-AirSpice-Token: <signed daily-budget token, optional>
 *     Body: { system, messages, tools, maxTokens, model? }
 *   Response: text/event-stream where every `data:` line is one of our
 *   neutral AgentEvent shapes as JSON. This provider's job is essentially
 *   `readSSE -> JSON.parse -> yield`.
 */

import { DEFAULT_BACKOFF, fetchWithRetry, readSSE, type BackoffConfig } from "../http.js";
import { RedactedError } from "../redact.js";
import { parseToolArgs } from "../repair.js";
import type {
  AgentEvent,
  AgentProvider,
  ChatRequest,
  MalformedToolCall,
  RetryConfig,
  ValidateKeyResult,
} from "../types.js";

/** Session-scoped storage the provider uses to cache the daily-budget token. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface HouseProviderOptions {
  /**
   * Base URL of the Worker (no trailing slash). E.g. "https://house.airspice.dev".
   * REQUIRED. An empty string throws — the fail-closed path from the design.
   */
  houseAgentUrl: string;
  /**
   * Optional model hint the Worker MAY honour. The Worker enforces its own
   * upper bound (never lets the client escalate past the configured default
   * tier); this is a soft downgrade knob only.
   */
  model?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides the shared exponential backoff. */
  retry?: RetryConfig;
  /**
   * Where to cache the signed daily-budget token. Defaults to `sessionStorage`
   * in the browser; falls back to an in-memory stub in Node/tests. Tokens are
   * *budget receipts*, not user identifiers.
   */
  tokenStorage?: TokenStorage;
}

const TOKEN_STORAGE_KEY = "airspice.house-agent.token";

/**
 * Curated Haiku-class default (see the cost model in the design doc). The
 * Worker enforces its own default; this string is a hint only.
 */
export const HOUSE_DEFAULT_MODEL = "claude-haiku-5";
export const HOUSE_MODELS = [HOUSE_DEFAULT_MODEL] as const;

export class HouseProvider implements AgentProvider {
  readonly id = "house" as const;
  readonly models = HOUSE_MODELS;
  readonly defaultModel = HOUSE_DEFAULT_MODEL;

  private readonly url: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: BackoffConfig;
  private readonly tokenStorage: TokenStorage;

  constructor(opts: HouseProviderOptions) {
    if (!opts.houseAgentUrl || opts.houseAgentUrl.trim() === "") {
      // Fail-closed (kill-switch layer 2 in the design doc): a build without a
      // configured URL must not accidentally reach ANY endpoint.
      throw new Error(
        "House agent not configured (VITE_HOUSE_AGENT_URL is unset). " +
          "Add your own API key in Settings to continue.",
      );
    }
    this.url = opts.houseAgentUrl.replace(/\/+$/, "");
    this.model = opts.model ?? this.defaultModel;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.backoff = opts.retry ?? DEFAULT_BACKOFF;
    this.tokenStorage = opts.tokenStorage ?? defaultTokenStorage();
  }

  /**
   * There is no user key to validate for the house agent — the point of the
   * lane is to be keyless. `validateKey` returns a fixed "not applicable"
   * ok-result so the settings UI does not misreport it. If callers want a
   * liveness probe against the Worker, that's a separate follow-up.
   */
  async validateKey(_key: string): Promise<ValidateKeyResult> {
    void _key;
    return { ok: true, detail: "House agent uses a hosted key; nothing to validate." };
  }

  async *chat(req: ChatRequest): AsyncIterable<AgentEvent> {
    const body = buildRequestBody(this.model, req);
    let response: Response;
    try {
      response = await fetchWithRetry(
        () =>
          this.fetchImpl(`${this.url}/v1/chat`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
            signal: req.signal,
          }),
        req.signal,
        undefined, // no API key on this lane; the Worker carries it
        this.backoff,
      );
    } catch (err) {
      yield asErrorEvent(err);
      return;
    }

    // The Worker may hand back an updated token in a response header — cache it
    // so the NEXT request advertises the debited budget. Tokens are budget
    // receipts, not identifiers, so storing them in sessionStorage is safe.
    const newToken = response.headers.get("X-AirSpice-Token");
    if (newToken) this.tokenStorage.setItem(TOKEN_STORAGE_KEY, newToken);

    yield* this.stream(response, req);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.tokenStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) headers["x-airspice-token"] = token;
    return headers;
  }

  /**
   * The Worker's SSE stream ships neutral `AgentEvent`s already. This is
   * essentially `readSSE -> parse -> yield`, plus a defensive re-validation of
   * any `tool-call` args against the request's tools (so a Worker bug can
   * never inject a schema-mismatched call that bypasses the recovery ladder).
   */
  private async *stream(
    response: Response,
    req: ChatRequest,
  ): AsyncGenerator<AgentEvent> {
    let sawDoneOrError = false;
    try {
      for await (const data of readSSE(response, req.signal)) {
        const ev = parseJson(data);
        if (!ev || typeof ev !== "object" || typeof (ev as { type?: unknown }).type !== "string") {
          continue;
        }
        const typed = ev as AgentEvent;
        // Tool-call defensive re-validation: rerun the args through the shared
        // recovery ladder against THIS turn's `req.tools`. If the Worker sends
        // an already-parsed `args`, we re-stringify and re-parse to hit the
        // same code path every provider uses.
        if (typed.type === "tool-call") {
          yield revalidateToolCall(typed, req);
          continue;
        }
        if (typed.type === "done" || typed.type === "error") {
          sawDoneOrError = true;
        }
        yield typed;
      }
    } catch (err) {
      yield asErrorEvent(err);
      return;
    }
    // A well-formed stream ends in exactly one `done` or `error`. If the
    // Worker dropped the connection without either, synthesize a terminal
    // done so the runner does not hang.
    if (!sawDoneOrError) {
      if (req.signal.aborted) {
        yield { type: "done", stopReason: "aborted" };
      } else {
        yield {
          type: "error",
          kind: "network",
          retryable: false,
          message: "House agent stream ended without a terminal event.",
        };
      }
    }
  }
}

function buildRequestBody(model: string, req: ChatRequest): Record<string, unknown> {
  return {
    system: req.system,
    messages: req.messages.map((m) => {
      // Preserve the multi-tool-call round-trip (issue #101 shape) verbatim;
      // the Worker forwards these onward to the upstream provider.
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.toolCalls !== undefined) out["toolCalls"] = m.toolCalls;
      if (m.toolCallId !== undefined) out["toolCallId"] = m.toolCallId;
      if (m.toolName !== undefined) out["toolName"] = m.toolName;
      return out;
    }),
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    maxTokens: req.maxTokens,
    model,
  };
}

function revalidateToolCall(
  ev: Extract<AgentEvent, { type: "tool-call" }>,
  req: ChatRequest,
): AgentEvent {
  const raw = ev.args === null ? (ev.malformed?.rawArgs ?? "") : JSON.stringify(ev.args);
  const parsed = parseToolArgs(ev.name, raw, req.tools);
  if (parsed.ok) {
    return { type: "tool-call", id: ev.id, name: ev.name, args: parsed.args };
  }
  const malformed: MalformedToolCall = parsed.malformed!;
  return {
    type: "tool-call",
    id: ev.id,
    name: ev.name,
    args: null,
    malformed,
  };
}

function asErrorEvent(err: unknown): AgentEvent {
  if (err instanceof RedactedError) return err.toEvent();
  return {
    type: "error",
    kind: "network",
    retryable: false,
    message: `House agent request failed: ${(err as Error).message}`,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `sessionStorage`-based token cache in the browser; an in-memory stub
 * elsewhere so the provider constructs cleanly in Node/SSR contexts.
 */
function defaultTokenStorage(): TokenStorage {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    /* sandboxed frame: fall through */
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}
