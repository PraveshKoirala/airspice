/**
 * Budget + rate-limit primitives for the house-agent Worker (issue #20).
 *
 * The prototype uses an in-memory `Map` so tests exercise the SAME code path
 * a deployed KV would run under. In production `Env.BUDGET` is a Cloudflare
 * KV namespace — this file's `KvLike` interface matches the subset of that
 * API we need (`get`, `put` with integer values). Swapping the in-memory
 * store for the real KV is a one-line construction change in `index.ts`.
 *
 * All counters store INTEGERS. Tokens are LLM tokens; the monthly cap is
 * stored in cents so KV never has to round a float.
 */

/** The subset of Cloudflare KV we use here. In-memory + KV both satisfy it. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/** An in-memory KV stub for tests. Not intended for production. */
export class InMemoryKv implements KvLike {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    void _opts;
    this.map.set(key, value);
  }

  /** Test helper: reset all counters. */
  reset(): void {
    this.map.clear();
  }
  /** Test helper: peek the current value of a counter. */
  peek(key: string): number {
    const v = this.map.get(key);
    return v ? parseInt(v, 10) : 0;
  }
  /** Test helper: iterate keys (used by tests to sum per-day debits). */
  keys(): IterableIterator<string> {
    return this.map.keys();
  }
}

/** Read an integer counter; missing => 0. */
async function readInt(kv: KvLike, key: string): Promise<number> {
  const raw = await kv.get(key);
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Add `delta` to the counter at `key`. Returns the new total. NOT atomic —
 * Cloudflare KV is eventually-consistent, so races bias slightly toward
 * OVER-counting (the Worker occasionally lets a request through and then
 * over-debits). That is the safe bias: it never lets a user spend more than
 * their cap in aggregate; it may cost them a few tokens they didn't get to
 * use. For strict atomicity a Durable Object is the drop-in swap.
 */
export async function increment(
  kv: KvLike,
  key: string,
  delta: number,
  ttlSeconds?: number,
): Promise<number> {
  const cur = await readInt(kv, key);
  const next = cur + delta;
  await kv.put(key, String(next), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  return next;
}

/** Read a counter without changing it. */
export async function read(kv: KvLike, key: string): Promise<number> {
  return readInt(kv, key);
}

/**
 * Sliding-window IP rate limit. Uses fixed-window bins (per minute); the
 * accepted trade-off is a client can burst up to `2 * limit` at the seam of
 * two windows. For M0-scale traffic this is fine; a Durable Object with a
 * genuine sliding-window queue is the upgrade path.
 */
export async function ipRateLimitOk(
  kv: KvLike,
  ipHash: string,
  perMinuteLimit: number,
  now: Date,
): Promise<{ ok: boolean; used: number }> {
  const bin = Math.floor(now.getTime() / 60_000);
  const key = `rl:${ipHash}:${bin}`;
  const used = await increment(kv, key, 1, 120);
  return { ok: used <= perMinuteLimit, used };
}

/**
 * Hash `raw` (typically an IP + rotating secret) to a stable bucket id
 * WITHOUT keeping the plaintext anywhere. Used as the KV key for the
 * per-IP rate limiter.
 */
export async function ipBucketId(ip: string, secret: string): Promise<string> {
  const buf = new TextEncoder().encode(`${secret}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}
