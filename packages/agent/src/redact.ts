/**
 * Key redaction (issue #17 / AGENTS.md rule 15).
 *
 * The API key must never appear in a log line, an error message, telemetry, or
 * any string that leaves the provider call. This module is the single choke
 * point: every error the providers throw is built through `providerError`, which
 * scrubs the key from the message; and `redactKey` is applied defensively to any
 * text that could conceivably have embedded the key (e.g. a provider echoing the
 * Authorization header back in an error body).
 *
 * The redaction is value-based (replace the literal key), not pattern-based, so
 * it cannot be defeated by an unusual key shape. A pattern fallback additionally
 * masks anything that *looks* like a provider key even if the exact value is not
 * known to the redactor (belt and suspenders for third-party error bodies).
 */

import type { ErrorEvent, ErrorKind } from "./types.js";

const REDACTED = "[REDACTED]";

// Common provider key shapes, masked even when the exact value is unknown to us
// (e.g. a key surfaced inside a nested provider error we did not originate).
const KEY_SHAPE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI
  /AIza[0-9A-Za-z_-]{20,}/g, // Google / Gemini
];

/**
 * Remove `key` (and anything key-shaped) from `text`. Safe on empty/short keys:
 * a key shorter than 8 chars is treated as absent to avoid masking unrelated
 * substrings, but the shape patterns still run.
 */
export function redactKey(text: string, key: string | undefined): string {
  let out = text;
  if (key && key.length >= 8) {
    // Replace every literal occurrence of the exact key.
    out = out.split(key).join(REDACTED);
  }
  for (const pat of KEY_SHAPE_PATTERNS) {
    out = out.replace(pat, REDACTED);
  }
  return out;
}

/**
 * Build a typed, redacted error event. This is the ONLY way providers surface an
 * error, guaranteeing no message ever carries the key. `raw` is whatever the
 * provider gave us (status text, error body); it is scrubbed before use.
 */
export function providerError(params: {
  kind: ErrorKind;
  retryable: boolean;
  message: string;
  key?: string | undefined;
  status?: number | undefined;
  raw?: string | undefined;
}): ErrorEvent {
  const detail = params.raw ? `${params.message}: ${params.raw}` : params.message;
  const safe = redactKey(detail, params.key);
  const event: ErrorEvent = {
    type: "error",
    kind: params.kind,
    retryable: params.retryable,
    message: safe,
  };
  if (params.status !== undefined) event.status = params.status;
  return event;
}

/**
 * A thrown error whose message is guaranteed key-free. Providers throw this so
 * the streaming loop can convert it to an `ErrorEvent` without re-deriving the
 * taxonomy. The key is scrubbed at construction, not at catch time, so even an
 * accidental `console.error(err)` upstream cannot leak it.
 */
export class RedactedError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(params: {
    kind: ErrorKind;
    retryable: boolean;
    message: string;
    key?: string | undefined;
    status?: number | undefined;
  }) {
    super(redactKey(params.message, params.key));
    this.name = "RedactedError";
    this.kind = params.kind;
    this.retryable = params.retryable;
    this.status = params.status;
  }

  toEvent(): ErrorEvent {
    const event: ErrorEvent = {
      type: "error",
      kind: this.kind,
      retryable: this.retryable,
      // this.message is already redacted by the constructor.
      message: this.message,
    };
    if (this.status !== undefined) event.status = this.status;
    return event;
  }
}
