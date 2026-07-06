/**
 * Signed daily-budget tokens for the house-agent Worker (issue #20).
 *
 * A token is a BUDGET RECEIPT, not a user id. It carries:
 *   { day: "YYYY-MM-DD", budget: <int>, nonce: <128-bit random> }
 * signed with a rotating HMAC-SHA256 secret. There is no user table, no
 * cookie, no fingerprint — the only property the Worker cares about is that
 * the same anonymous browser can be rate-limited within a UTC day without
 * anyone being able to forge extra headroom.
 *
 * On rejection (bad signature / day != today / budget exhausted) the Worker
 * mints a fresh token; the client caches it in `sessionStorage`.
 */

export interface TokenPayload {
  /** UTC day the token was minted, YYYY-MM-DD. */
  day: string;
  /** Token cap for the day (LLM tokens, upstream `usage` accounting). */
  budget: number;
  /** 128 bits of randomness so token IDs never collide across users. */
  nonce: string;
}

/** UTC day string in YYYY-MM-DD. Determinism: no `Date.now` in test paths. */
export function utcDay(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Base64url encode (no padding), from bytes. */
function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Base64url encode a UTF-8 string. */
function b64urlText(text: string): string {
  return b64urlBytes(new TextEncoder().encode(text));
}

/** Base64url decode to bytes. */
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

/** Constant-time compare. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Mint a fresh token for the given payload. Format: `<b64url(json)>.<b64url(sig)>`.
 * `nonce` is generated here so the caller never has to touch `crypto`.
 */
export async function mintToken(
  secret: string,
  day: string,
  budget: number,
): Promise<{ token: string; payload: TokenPayload }> {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const payload: TokenPayload = { day, budget, nonce: b64urlBytes(nonceBytes) };
  const header = b64urlText(JSON.stringify(payload));
  const sig = await hmacSign(secret, header);
  return { token: `${header}.${b64urlBytes(sig)}`, payload };
}

/**
 * Verify a token. Returns the payload on success, `null` on any failure
 * (bad shape, bad signature, wrong day). The Worker treats a `null` return
 * as "mint a fresh one" — a rejected token is not a fatal error.
 */
export async function verifyToken(
  secret: string,
  token: string,
  today: string,
): Promise<TokenPayload | null> {
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const header = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let expected: Uint8Array;
  try {
    expected = await hmacSign(secret, header);
  } catch {
    return null;
  }
  let received: Uint8Array;
  try {
    received = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, received)) return null;
  let payload: TokenPayload;
  try {
    const json = new TextDecoder().decode(b64urlDecode(header));
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.day !== "string" ||
    typeof payload.budget !== "number" ||
    typeof payload.nonce !== "string"
  ) {
    return null;
  }
  if (payload.day !== today) return null;
  return payload;
}
