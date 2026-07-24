/**
 * Share links — a circuit IS a URL (issue #27).
 *
 * A design is compressed into the URL **fragment** (`#…`) so sharing needs no
 * server, no account, and no storage: the payload never leaves the browser as a
 * network request (fragments are not sent to servers, so they never hit a log).
 *
 * This module is PURE: no DOM, no React, no `window`/`location`. It is the
 * codec only — the UI layer (App.tsx / Toolbar.tsx) owns clipboard, toasts, the
 * export fallback, and routing the decoded XML through the air-ts security +
 * normalize + validate gate as untrusted input.
 *
 * Wire format (fragment body, no leading '#'):  `d=<payload>&v=1`
 *   payload = base64url( deflate-raw( utf8(xml) ) )   — no '=' padding.
 *
 * Real compression (fflate raw DEFLATE at level 9), real base64url, real
 * round-trip. `decodeHashToDesign` NEVER throws: malformed / corrupt / oversize
 * input returns a typed `{ ok: false; error }` result, and a decompression bomb
 * is bounded by a streaming cap (`MAX_DECODED_BYTES`) rather than by inflating
 * the whole payload first.
 */

import { deflateSync, Inflate } from "fflate";

/** Wire-format version stamped into every share fragment (`&v=1`). */
export const SHARE_VERSION = 1;
/** Warn threshold on the base64url payload length (very long URLs break apps). */
export const SHARE_SOFT_LIMIT_BYTES = 8 * 1024; // 8 KiB
/** Hard cap on the payload length: beyond this we refuse to hand out a URL. */
export const SHARE_HARD_LIMIT_BYTES = 32 * 1024; // 32 KiB
/** Decompression-bomb guard: reject any fragment that inflates beyond this. */
export const MAX_DECODED_BYTES = 5 * 1024 * 1024; // 5 MiB

// --- base64url codec (RFC 4648 §5, no padding) ------------------------------ #
//
// Operates directly on bytes (no atob/btoa): atob works on Latin-1 "binary
// strings" and needs manual url-safe + padding fixups, and `String.fromCharCode
// (...bytes)` blows the call stack on large inputs. A direct byte codec is
// deterministic, dependency-free, and stack-safe for any payload size.

const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** ASCII code point -> 6-bit value; -1 for any byte outside the alphabet. */
const B64URL_REVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 3 <= len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63] +
      B64URL_ALPHABET[n & 63];
  }
  const remaining = len - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63] + B64URL_ALPHABET[(n >>> 12) & 63];
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63] +
      B64URL_ALPHABET[(n >>> 12) & 63] +
      B64URL_ALPHABET[(n >>> 6) & 63];
  }
  return out;
}

/** Decode base64url (no padding) to bytes; `null` on any invalid input. */
function base64UrlToBytes(text: string): Uint8Array | null {
  const len = text.length;
  // A 4-char base64 group encodes 3 bytes; the only impossible remainder is 1.
  if (len % 4 === 1) return null;
  const remainder = len % 4;
  const outLen = (len >> 2) * 3 + (remainder === 0 ? 0 : remainder - 1);
  const out = new Uint8Array(outLen);
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? B64URL_REVERSE[code] : -1;
    if (value === -1) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (accumulator >>> bits) & 0xff;
    }
  }
  return out;
}

// --- deflate / inflate ------------------------------------------------------ #

/** Shared encode step: deflate-raw(utf8(xml)) -> base64url payload. */
function encodePayload(xml: string): string {
  const utf8 = new TextEncoder().encode(xml);
  const compressed = deflateSync(utf8, { level: 9 });
  return bytesToBase64Url(compressed);
}

type InflateOutcome =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "corrupt" }
  | { kind: "too-large" };

/**
 * Raw-inflate `data` with a hard output cap. Uses fflate's STREAMING `Inflate`
 * so a decompression bomb is rejected as soon as the cumulative output crosses
 * `MAX_DECODED_BYTES` — we stop collecting chunks instead of allocating the
 * whole (potentially enormous) output first. A malformed / truncated stream
 * makes `push` throw, which we map to `corrupt`.
 */
function inflateRawCapped(data: Uint8Array): InflateOutcome {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const inflater = new Inflate();
  inflater.ondata = (chunk) => {
    if (overflow) return;
    total += chunk.length;
    if (total > MAX_DECODED_BYTES) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  };
  try {
    inflater.push(data, true);
  } catch {
    return { kind: "corrupt" };
  }
  if (overflow) return { kind: "too-large" };
  if (chunks.length === 1) return { kind: "ok", bytes: chunks[0] };
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { kind: "ok", bytes: merged };
}

// --- public API ------------------------------------------------------------- #

/**
 * `deflate-raw(utf8(xml))` -> base64url (no '=') -> the fragment BODY
 * `d=<payload>&v=1` (NO leading '#').
 */
export function encodeDesignToHash(xml: string): string {
  return `d=${encodePayload(xml)}&v=${SHARE_VERSION}`;
}

export type DecodeResult =
  | { ok: true; xml: string }
  | {
      ok: false;
      error: "empty" | "bad-version" | "malformed" | "corrupt" | "too-large";
    };

/**
 * Decode a share fragment back to the original XML. Accepts the fragment with
 * or without a leading '#'. NEVER throws — every failure mode is a typed result:
 *   - missing `d`                    -> `empty`
 *   - `v` is not "1"                 -> `bad-version`
 *   - base64url decode fails         -> `malformed`
 *   - inflate fails (corrupt stream) -> `corrupt`
 *   - inflated bytes are not UTF-8   -> `corrupt`
 *   - inflated size > cap            -> `too-large`
 *
 * Round-trip guarantee: for any UTF-8 string `x`,
 *   `decodeHashToDesign("#" + encodeDesignToHash(x)).xml === x`.
 */
export function decodeHashToDesign(hash: string): DecodeResult {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(body);

  const payload = params.get("d");
  if (!payload) return { ok: false, error: "empty" };

  const version = params.get("v");
  if (version !== String(SHARE_VERSION)) return { ok: false, error: "bad-version" };

  const compressed = base64UrlToBytes(payload);
  if (compressed === null) return { ok: false, error: "malformed" };

  const inflated = inflateRawCapped(compressed);
  if (inflated.kind === "too-large") return { ok: false, error: "too-large" };
  if (inflated.kind === "corrupt") return { ok: false, error: "corrupt" };

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(inflated.bytes);
  } catch {
    return { ok: false, error: "corrupt" };
  }
  return { ok: true, xml };
}

export interface ShareUrlInfo {
  /** `${origin}/#d=<payload>&v=1`. */
  url: string;
  /** Byte length of the base64url payload (ASCII, so == its string length). */
  payloadBytes: number;
  /** `payloadBytes > SHARE_SOFT_LIMIT_BYTES` (warn: long URLs break in apps). */
  overSoft: boolean;
  /** `payloadBytes > SHARE_HARD_LIMIT_BYTES` (refuse: hand out an export instead). */
  overHard: boolean;
}

/**
 * Build the full shareable URL from the design XML and an `origin` such as
 * `"https://airspice.app"` (no trailing slash). Reports the payload size and
 * the soft/hard threshold flags so the caller can warn or fall back to export.
 */
export function buildShareUrl(xml: string, origin: string): ShareUrlInfo {
  const payload = encodePayload(xml);
  const payloadBytes = payload.length;
  return {
    url: `${origin}/#d=${payload}&v=${SHARE_VERSION}`,
    payloadBytes,
    overSoft: payloadBytes > SHARE_SOFT_LIMIT_BYTES,
    overHard: payloadBytes > SHARE_HARD_LIMIT_BYTES,
  };
}
