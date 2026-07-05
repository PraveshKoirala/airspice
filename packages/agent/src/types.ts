/**
 * Provider-agnostic agent types (issue #17).
 *
 * These are the wire-neutral shapes every provider maps to. A provider's job is
 * to translate the provider's own request/response format to/from these types,
 * so the rest of the app (tool runtime #18, repair loop #19, settings UI) never
 * branches on which provider is active.
 *
 * The tool-schema shape (`ToolSpec`) mirrors the JSON-schema tool definitions in
 * the Python agent (`AIR_TOOLS` in `agent.py`): a name, a human description, and
 * a JSON-Schema object for the parameters. Anthropic, OpenAI, and Gemini all
 * accept function/tool definitions of exactly this shape (each under a slightly
 * different key), which is why one neutral `ToolSpec` serves all three.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "mock";

/** A single JSON-Schema-ish object describing a tool's parameters. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/** A tool the model may call. Shape is provider-neutral (see file header). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-Schema for the tool's arguments. */
  parameters: JsonSchema;
}

/**
 * A tool call the ASSISTANT made in a turn, carried on the assistant `Msg` so
 * the turn can be REPLAYED to the provider with its tool-use blocks intact.
 *
 * This is what fixes the multi-tool-call round-trip (issue #101): when a repair
 * turn issues two `propose_patch` calls, the assistant message must re-serialize
 * BOTH tool-use blocks (each with its `id`), so the following `tool_result`
 * blocks reference VALID ids. Without this the assistant turn is replayed as
 * plain text, the ids are orphaned, and Anthropic/OpenAI/Gemini all 400.
 *
 * `id` matches the `toolCallId` of the `role: "tool"` message that answers it.
 * `args` is the parsed argument object; when the model emitted arguments that
 * did not parse (a malformed call still answered with a structured error via the
 * recovery ladder) `args` is `null` — providers serialize an empty argument
 * object in that case, since the id (not the arguments) is what must round-trip.
 */
export interface MsgToolCall {
  /** Provider-assigned id; echoed on the answering `tool` message's toolCallId. */
  id: string;
  name: string;
  /** Parsed args, or `null` when the original call was malformed. */
  args: Record<string, unknown> | null;
}

/** One turn in the conversation. Tool results are fed back as `tool` messages. */
export interface Msg {
  role: "user" | "assistant" | "tool";
  /** Free-text content (user/assistant prose, or a tool result payload). */
  content: string;
  /**
   * For `role: "assistant"` messages: the tool calls the model made this turn,
   * preserved so the turn replays with its tool-use blocks (issue #101). Absent
   * or empty for a plain-text assistant turn. Ignored for user/tool messages.
   */
  toolCalls?: MsgToolCall[];
  /**
   * For `role: "tool"` messages: the id of the tool call this result answers,
   * so the provider can correlate the result to the originating call. Ignored
   * for user/assistant messages.
   */
  toolCallId?: string;
  /** For `role: "tool"`: the tool name (some providers want it echoed). */
  toolName?: string;
}

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  maxTokens: number;
  signal: AbortSignal;
}

// --------------------------------------------------------------------------- //
// Streamed events. `chat` yields these in order; a well-formed turn ends with
// exactly one `done` OR one `error`. `text-delta` and `tool-call` may interleave
// and repeat; `usage` (token accounting) is emitted at most once, before `done`.
// --------------------------------------------------------------------------- //

export interface TextDeltaEvent {
  type: "text-delta";
  /** Incremental assistant text. Concatenate deltas to reassemble the message. */
  text: string;
}

export interface ToolCallEvent {
  type: "tool-call";
  /** Provider-assigned id, echoed back on the tool-result message. */
  id: string;
  name: string;
  /**
   * Parsed arguments. `null` when the model emitted arguments that were not
   * valid JSON or did not match the tool schema -- the recovery ladder (see
   * `repair.ts`) keys off `malformed` to decide whether to feed back a
   * structured error and retry, or abort the turn.
   */
  args: Record<string, unknown> | null;
  /** Present only when `args` is null: why parsing/validation failed. */
  malformed?: MalformedToolCall;
}

/** Detail attached to a malformed tool call, fed back to the model verbatim. */
export interface MalformedToolCall {
  /** Stable machine code surfaced to the model and counted in settings. */
  kind: "invalid_json" | "unknown_tool" | "schema_mismatch" | "truncated";
  /** The raw argument text the model emitted (may be partial / unparseable). */
  rawArgs: string;
  /** Human-readable reason (also shown as a subdued system note in chat). */
  detail: string;
}

export interface UsageEvent {
  type: "usage";
  inputTokens: number;
  outputTokens: number;
}

export interface DoneEvent {
  type: "done";
  /**
   * Why the turn ended: `stop` (model finished), `tool_use` (model wants tool
   * results and expects another turn), `max_tokens` (budget hit), or `aborted`
   * (the caller's AbortSignal fired).
   */
  stopReason: "stop" | "tool_use" | "max_tokens" | "aborted";
}

/** Typed error taxonomy (issue: auth / quota / network / model). */
export type ErrorKind = "auth" | "quota" | "network" | "model" | "aborted";

export interface ErrorEvent {
  type: "error";
  kind: ErrorKind;
  /** Whether a retry could plausibly succeed (drives the backoff wrapper). */
  retryable: boolean;
  /** Redacted, user-safe message. NEVER contains the API key (see redact.ts). */
  message: string;
  /** HTTP status, when the error originated from a provider response. */
  status?: number;
}

export type AgentEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent;

export interface ValidateKeyResult {
  ok: boolean;
  detail: string;
}

/**
 * The provider contract. Every implementation (Anthropic, OpenAI, Gemini, Mock)
 * exposes exactly this surface; callers never see provider-specific types.
 */
export interface AgentProvider {
  readonly id: ProviderId;
  /** Curated model ids for this provider (settings UI seeds its picker). */
  readonly models: readonly string[];
  /** The model used when the user has not chosen one. */
  readonly defaultModel: string;
  chat(req: ChatRequest): AsyncIterable<AgentEvent>;
  validateKey(key: string): Promise<ValidateKeyResult>;
}

/** Backoff configuration for the shared retry wrapper (injectable for tests). */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  /** Injected for deterministic tests; defaults to a real abortable timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Construction options common to the real (network) providers. */
export interface ProviderOptions {
  apiKey: string;
  /** Overrides `defaultModel`. Free-text is allowed (settings UI supports it). */
  model?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides the default exponential backoff (max 3 retries, 500ms base). */
  retry?: RetryConfig;
}
