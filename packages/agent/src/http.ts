/**
 * Shared HTTP concerns for the network providers (issue #17):
 *   - status -> typed error taxonomy (auth / quota / network / model)
 *   - exponential backoff on 429 / 5xx (max 3 retries), abort-aware
 *   - Server-Sent-Events line reader used by Anthropic and OpenAI streams
 *
 * None of this contacts a server itself; it wraps a caller-supplied request
 * function so the same retry/abort semantics apply to every provider and are
 * exercised deterministically in tests with a mocked `fetch`.
 */

import { RedactedError } from "./redact.js";
import type { ErrorKind } from "./types.js";

/** Map an HTTP status to the typed error taxonomy + retryability. */
export function classifyStatus(status: number): {
  kind: ErrorKind;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "quota", retryable: true };
  if (status >= 500) return { kind: "network", retryable: true };
  if (status === 400 || status === 404 || status === 422) {
    // Bad request / unknown model / unprocessable -> a model/config problem the
    // user must fix; retrying the identical request will not help.
    return { kind: "model", retryable: false };
  }
  // Other 4xx: treat as a non-retryable model/config error.
  return { kind: "model", retryable: false };
}

/** True for the DOMException a fetch throws when its signal aborts. */
export function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException
      ? err.name === "AbortError"
      : err instanceof Error && err.name === "AbortError"
  );
}

export interface BackoffConfig {
  maxRetries: number;
  /** Base delay in ms; attempt n waits baseDelayMs * 2^n. */
  baseDelayMs: number;
  /** Injected for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffConfig, "sleep">> = {
  maxRetries: 3,
  baseDelayMs: 500,
};

/** Abortable sleep. Rejects with an AbortError if the signal fires first. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` with exponential backoff on retryable failures. `attempt`
 * returns a `Response`; a non-ok response with a retryable status is retried up
 * to `maxRetries` times, otherwise the (last) response is returned for the
 * caller to surface as a typed error. Network throws (fetch rejects) are treated
 * as retryable. Abort is never retried.
 *
 * Returns the successful (ok) Response, or throws a RedactedError describing the
 * final failure.
 */
export async function fetchWithRetry(
  attempt: (attemptIndex: number) => Promise<Response>,
  signal: AbortSignal,
  key: string | undefined,
  config: BackoffConfig = DEFAULT_BACKOFF,
): Promise<Response> {
  const maxRetries = config.maxRetries;
  const baseDelayMs = config.baseDelayMs;
  const sleep = config.sleep ?? abortableSleep;

  let lastError: RedactedError | null = null;

  for (let i = 0; i <= maxRetries; i++) {
    if (signal.aborted) {
      throw new RedactedError({
        kind: "aborted",
        retryable: false,
        message: "Request aborted",
        key,
      });
    }
    let response: Response;
    try {
      response = await attempt(i);
    } catch (err) {
      if (isAbortError(err)) {
        throw new RedactedError({
          kind: "aborted",
          retryable: false,
          message: "Request aborted",
          key,
        });
      }
      // Network-level failure (DNS, connection reset, CORS block surfacing as a
      // TypeError). Retryable; remember it and back off.
      lastError = new RedactedError({
        kind: "network",
        retryable: true,
        message: `Network error contacting provider: ${(err as Error).message}`,
        key,
      });
      if (i < maxRetries) {
        await sleep(baseDelayMs * 2 ** i, signal);
        continue;
      }
      throw lastError;
    }

    if (response.ok) return response;

    const { kind, retryable } = classifyStatus(response.status);
    if (retryable && i < maxRetries) {
      lastError = new RedactedError({
        kind,
        retryable: true,
        message: `Provider returned ${response.status}`,
        key,
        status: response.status,
      });
      await sleep(retryDelay(response, baseDelayMs, i), signal);
      continue;
    }

    // Non-retryable, or out of retries: surface a typed error with the body.
    const body = await safeReadBody(response);
    throw new RedactedError({
      kind,
      retryable,
      message: `Provider returned ${response.status}${body ? `: ${body}` : ""}`,
      key,
      status: response.status,
    });
  }

  // Unreachable in practice (the loop either returns or throws), but keeps the
  // type checker happy and gives a defined behaviour if maxRetries < 0.
  throw (
    lastError ??
    new RedactedError({
      kind: "network",
      retryable: false,
      message: "Request failed",
      key,
    })
  );
}

/** Honour a `Retry-After` header (seconds) when present; else exponential. */
function retryDelay(response: Response, baseDelayMs: number, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return baseDelayMs * 2 ** attempt;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Cap the echoed body so a huge error page cannot bloat the message.
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return "";
  }
}

/**
 * Turn a streamed Response body into an async iterator of Server-Sent-Events
 * `data:` payloads (the string after `data: `). Handles chunk boundaries that
 * split a line, and stops on the SSE sentinel `[DONE]` if a provider uses it.
 * Aborts cleanly when the signal fires.
 */
export async function* readSSE(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      // SSE events are newline-delimited; a single `data:` line per event for
      // both Anthropic and OpenAI. Split on \n and emit complete lines.
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trimEnd();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
    }
    // Flush any trailing buffered line.
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice("data:".length).trim();
      if (data && data !== "[DONE]") yield data;
    }
  } finally {
    // Best-effort: release the lock; on abort the underlying fetch is cancelled
    // by the caller's signal so the connection is torn down.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
