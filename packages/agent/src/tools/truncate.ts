/**
 * Tool-result hygiene (issue #18 deliverable 4; guardrail "do NOT let tool
 * results grow unbounded — context explosions are silent quality killers").
 *
 * Every value the runtime feeds back to the model as a tool result is passed
 * through `capToolResult`, which:
 *   - serializes the payload deterministically (sorted keys — see stableStringify),
 *   - and, if the serialized string exceeds the char cap, keeps a HEAD and a
 *     TAIL and replaces the middle with an explicit, machine-visible marker
 *     `...[truncated N chars]...` so the model KNOWS the result was clipped
 *     (silent clipping would make it hallucinate the missing middle).
 *
 * Head+tail (not head-only) because both ends of a tool result carry signal:
 * the head has the summary/status, the tail has the most recent
 * diagnostics/stderr lines. Simulation stderr specifically is summarized to the
 * last few lines BEFORE it ever reaches here (see runtime.ts), so this is the
 * second line of defense, not the first.
 *
 * The cap is measured in CHARACTERS (a portable proxy for tokens that needs no
 * tokenizer in the browser); a conservative ~4 chars/token ratio means the
 * default 6 000-char cap is ~1 500 tokens per tool result — generous for a
 * diagnostics list or a report summary, bounded against a pathological dump.
 */

/** Default per-result character cap (~1.5k tokens at ~4 chars/token). */
export const DEFAULT_RESULT_CHAR_CAP = 6000;

/** Marker inserted where the middle of an over-cap result was removed. */
function truncationMarker(removed: number): string {
  return `\n...[truncated ${removed} chars]...\n`;
}

/**
 * Deterministic JSON: object keys sorted recursively so the same payload always
 * serializes to the same string (determinism guardrail; also makes the char cap
 * reproducible). Arrays keep order; primitives pass through.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value), null, 2);
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Cap a raw STRING to `charCap` with head+tail truncation. Used for pre-
 * serialized text (e.g. a design's XML) where we don't want to re-serialize.
 */
export function capString(text: string, charCap: number = DEFAULT_RESULT_CHAR_CAP): string {
  if (text.length <= charCap) return text;
  const marker = truncationMarker(text.length - charCap);
  // Reserve room for the marker; split the remaining budget head:tail ~= 60:40
  // (the head/status is usually the denser signal).
  const budget = Math.max(0, charCap - marker.length);
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  return head + marker + tail;
}

/**
 * Serialize a tool-result payload deterministically and cap it. Returns the
 * bounded STRING the runtime hands back to the model as the tool message.
 *
 * `charCap` is the hard ceiling on the returned string length (including the
 * truncation marker), so a caller can rely on `capToolResult(...).length <=
 * charCap` for every tool, on every input.
 */
export function capToolResult(
  payload: unknown,
  charCap: number = DEFAULT_RESULT_CHAR_CAP,
): string {
  return capString(stableStringify(payload), charCap);
}

/**
 * Summarize an stderr line list to its last `keep` lines, prefixed with a count
 * so the model sees "42 lines, showing last 5" instead of a 42-line dump. This
 * is the simulation-stderr-summarized-not-dumped rule (deliverable 4), applied
 * before the value is ever serialized into a tool result.
 */
export function summarizeStderr(lines: readonly string[], keep: number = 5): string {
  if (lines.length === 0) return "";
  if (lines.length <= keep) return lines.join("\n");
  const tail = lines.slice(lines.length - keep);
  return `[${lines.length} stderr lines; showing last ${keep}]\n` + tail.join("\n");
}
