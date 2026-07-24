/**
 * Unit tests for the share-link codec (issue #27).
 *
 * These target the interface contract in the PRD ONLY — there is no
 * implementation in this worktree by design. The module under test is
 * `packages/ui/src/share/shareLink.ts`, which the builder will create.
 *
 * Every test here is written to FAIL against a trivial stub (identity encode /
 * passthrough decode, or base64-of-plaintext) and pass ONLY against a real
 * fflate raw-deflate + base64url codec with the specified error taxonomy and
 * decompression-bomb guard:
 *
 *   1. round-trip byte-identity over the on-disk corpus — a base64-identity or
 *      passthrough codec can pass this alone, so it is paired with (2).
 *   2. url-safe + COMPRESSIVE payload — base64-of-plaintext is ~1.33x the raw
 *      size, so `payload < raw/10` on a repetitive design can only hold for a
 *      real deflate; a passthrough payload is not url-safe.
 *   3. version tag + full decode error taxonomy — a decoder that ignores the
 *      version, or returns ok for garbage, fails here.
 *   4. corruption fuzz — a decoder that throws (no try/catch around atob /
 *      inflate) fails the never-throw contract.
 *   5. oversize + decompression bomb — a decoder with no MAX_DECODED guard
 *      inflates a 5MB bomb and returns ok instead of `too-large`.
 *   6. buildShareUrl exact format + boundary flags — a stub that hard-codes the
 *      flags or the url shape fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deflateSync } from "fflate";
import {
  encodeDesignToHash,
  decodeHashToDesign,
  buildShareUrl,
  SHARE_VERSION,
  SHARE_SOFT_LIMIT_BYTES,
  SHARE_HARD_LIMIT_BYTES,
  MAX_DECODED_BYTES,
} from "../../src/share/shareLink";

// ---------------------------------------------------------------------------
// Test helpers (deliberately independent of the implementation).
// ---------------------------------------------------------------------------

/** Locate the repo-root `examples/` dir by walking up from this test file. */
function findExamplesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "examples");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate examples/ directory");
}

/** Read every `examples/<name>/design.air.xml` as an exact UTF-8 string. */
function loadCorpus(): Array<{ name: string; xml: string }> {
  const dir = findExamplesDir();
  const out: Array<{ name: string; xml: string }> = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, "design.air.xml");
    if (existsSync(file) && statSync(file).isFile()) {
      out.push({ name, xml: readFileSync(file, "utf8") });
    }
  }
  return out;
}

const CORPUS = loadCorpus();

/** Extract the `d` param value out of a `d=<payload>&v=1` fragment body. */
function payloadOf(hashBody: string): string {
  const m = hashBody.replace(/^#/, "").match(/(?:^|&)d=([^&]*)/);
  if (!m) throw new Error(`no d= param in ${hashBody.slice(0, 40)}...`);
  return m[1]!;
}

/** Extract the `v` param value. */
function versionOf(hashBody: string): string | null {
  const m = hashBody.replace(/^#/, "").match(/(?:^|&)v=([^&]*)/);
  return m ? m[1]! : null;
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Deterministic PRNG (mulberry32) so any fuzz failure reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** ~6 bits/char content that deflate cannot compress below its entropy. */
function randomIncompressible(n: number, seed: number): string {
  const rnd = mulberry32(seed);
  const chars = new Array<string>(n);
  for (let i = 0; i < n; i++) chars[i] = B64URL_ALPHABET[(rnd() * 64) | 0]!;
  return chars.join("");
}

// ---------------------------------------------------------------------------

describe("shareLink constants pin the PRD contract", () => {
  it("exposes the exact version + limit constants", () => {
    expect(SHARE_VERSION).toBe(1);
    expect(SHARE_SOFT_LIMIT_BYTES).toBe(8 * 1024);
    expect(SHARE_HARD_LIMIT_BYTES).toBe(32 * 1024);
    expect(MAX_DECODED_BYTES).toBe(5 * 1024 * 1024);
  });
});

// 1. Round-trip byte-identity over the on-disk corpus.
describe("1. round-trip byte-identity over examples/*/design.air.xml", () => {
  it("finds a non-empty corpus (guards against a vacuous suite)", () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const { name, xml } of CORPUS) {
    it(`round-trips ${name} exactly, byte for byte`, () => {
      const body = encodeDesignToHash(xml);
      const withHash = decodeHashToDesign("#" + body);
      expect(withHash.ok).toBe(true);
      if (withHash.ok) expect(withHash.xml).toBe(xml);

      // The decoder must accept a fragment WITHOUT the leading '#' too.
      const noHash = decodeHashToDesign(body);
      expect(noHash.ok).toBe(true);
      if (noHash.ok) expect(noHash.xml).toBe(xml);
    });
  }

  it("round-trips assorted arbitrary strings (unicode, control chars, empty-ish)", () => {
    const samples = [
      "",
      "a",
      "<system/>",
      "‽ émoji 🔋 – uNiCoDe ✓",
      "line1\nline2\r\ntab\tend",
      "<xml>" + "x".repeat(5000) + "</xml>",
    ];
    for (const s of samples) {
      const r = decodeHashToDesign("#" + encodeDesignToHash(s));
      expect(r.ok, `round-trip failed for ${JSON.stringify(s.slice(0, 20))}`).toBe(true);
      if (r.ok) expect(r.xml).toBe(s);
    }
  });
});

// 2. url-safe + COMPRESSIVE (proves real deflate, not base64-of-plaintext).
describe("2. payload is url-safe and compressive", () => {
  it("emits only base64url characters (no '=', '+', '/', '#')", () => {
    for (const { name, xml } of CORPUS) {
      const payload = payloadOf(encodeDesignToHash(xml));
      expect(payload, `${name} payload not url-safe`).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("compresses a large repetitive design far below the raw byte size", () => {
    const block =
      '  <component id="R" type="resistor"><value>1k</value>' +
      '<pin name="1" net="a"/><pin name="2" net="b"/></component>\n';
    const bigXml =
      '<?xml version="1.0"?>\n<system name="rep" ir_version="0.1">\n<components>\n' +
      block.repeat(2000) +
      "</components>\n</system>\n";

    const payload = payloadOf(encodeDesignToHash(bigXml));
    const rawBytes = utf8Len(bigXml);
    const payloadBytes = utf8Len(payload);

    // A base64-of-plaintext codec produces ~1.33x the raw size; real deflate on
    // this highly repetitive input collapses it by >10x. This gap is the proof.
    expect(payloadBytes).toBeLessThan(rawBytes / 10);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);

    // And it must still round-trip exactly.
    const r = decodeHashToDesign("#" + encodeDesignToHash(bigXml));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.xml).toBe(bigXml);
  });
});

// 3. version tag + full decode error taxonomy.
describe("3. version tag and decode error taxonomy", () => {
  const sampleXml = CORPUS[0]?.xml ?? "<system/>";

  it("stamps &v=1 on the encoded fragment body", () => {
    const body = encodeDesignToHash(sampleXml);
    expect(versionOf(body)).toBe("1");
    expect(body.startsWith("d=")).toBe(true);
    expect(body).toMatch(/(^|&)v=1(&|$)/);
  });

  it("rejects a mismatched version with error 'bad-version'", () => {
    const payload = payloadOf(encodeDesignToHash(sampleXml));
    for (const v of ["2", "0", "99"]) {
      const r = decodeHashToDesign(`#d=${payload}&v=${v}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("bad-version");
    }
    // A missing version is also not "1" => bad-version.
    const missing = decodeHashToDesign(`#d=${payload}`);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe("bad-version");
  });

  it("returns 'empty' when the d param is absent", () => {
    for (const h of ["", "#", "#v=1", "#foo=bar&v=1"]) {
      const r = decodeHashToDesign(h);
      expect(r.ok, `expected empty for ${JSON.stringify(h)}`).toBe(false);
      if (!r.ok) expect(r.error).toBe("empty");
    }
  });

  it("returns 'malformed' when the payload is not valid base64url", () => {
    // A single base64 char cannot decode to any byte (length % 4 === 1) — every
    // conforming base64url decoder rejects it.
    const r = decodeHashToDesign("#d=A&v=1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("malformed");
  });

  it("returns 'corrupt' when the bytes are valid base64url but not deflate", () => {
    // "AAAA" => 3 zero bytes, which is a truncated/invalid raw-deflate stream.
    const r = decodeHashToDesign("#d=AAAA&v=1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("corrupt");
  });
});

// 4. Corruption fuzz — the decoder must NEVER throw.
describe("4. corruption fuzz never throws", () => {
  it("survives 800 random mutations / truncations without throwing", () => {
    const valid = "#" + encodeDesignToHash(CORPUS[0]?.xml ?? "<system>fuzz</system>");
    const rnd = mulberry32(0xc0ffee);
    const printable = () => String.fromCharCode(33 + ((rnd() * 94) | 0)); // '!'..'~'
    const allowed = new Set(["empty", "bad-version", "malformed", "corrupt", "too-large"]);

    for (let i = 0; i < 800; i++) {
      const mode = (rnd() * 3) | 0;
      let mutated: string;
      if (mode === 0) {
        const arr = valid.split("");
        const pos = (rnd() * arr.length) | 0;
        arr[pos] = printable();
        mutated = arr.join("");
      } else if (mode === 1) {
        mutated = valid.slice(0, (rnd() * valid.length) | 0);
      } else {
        const len = (rnd() * 48) | 0;
        let junk = "";
        for (let k = 0; k < len; k++) junk += printable();
        mutated = (rnd() < 0.5 ? "#d=" : "#") + junk + (rnd() < 0.5 ? "&v=1" : "");
      }

      let result: ReturnType<typeof decodeHashToDesign> | undefined;
      expect(() => {
        result = decodeHashToDesign(mutated);
      }, `decode threw on iteration ${i}: ${JSON.stringify(mutated.slice(0, 60))}`).not.toThrow();

      expect(result).toBeDefined();
      const r = result!;
      expect(typeof r.ok).toBe("boolean");
      if (r.ok) {
        expect(typeof r.xml).toBe("string");
      } else {
        expect(allowed.has(r.error)).toBe(true);
      }
    }
  });
});

// 5. Oversize + decompression bomb.
describe("5. oversize and decompression-bomb guards", () => {
  it("flags overHard when the payload exceeds the hard limit", () => {
    // ~60k of incompressible content -> payload well above 32KB.
    const bigXml = randomIncompressible(60_000, 0xa11ce);
    const info = buildShareUrl(bigXml, "https://airspice.app");
    expect(info.payloadBytes).toBeGreaterThan(SHARE_HARD_LIMIT_BYTES);
    expect(info.overHard).toBe(true);
    expect(info.overSoft).toBe(true);
  });

  it("returns 'too-large' for a payload that inflates past MAX_DECODED_BYTES", () => {
    // A classic zip bomb: a few KB of base64url that inflates to >5MB.
    const bombLen = MAX_DECODED_BYTES + 1024;
    const deflated = deflateSync(new TextEncoder().encode("A".repeat(bombLen)), {
      level: 9,
    });
    const payload = bytesToBase64Url(deflated);

    // Sanity: the bomb payload really is tiny relative to what it inflates to.
    expect(payload.length).toBeLessThan(bombLen / 100);

    const r = decodeHashToDesign(`#d=${payload}&v=1`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too-large");
  });
});

// 6. buildShareUrl exact format + boundary flags.
describe("6. buildShareUrl format and boundary flags", () => {
  const origin = "https://airspice.app";

  it("produces `${origin}/#d=<payload>&v=1` consistent with encodeDesignToHash", () => {
    const xml = CORPUS[0]?.xml ?? "<system/>";
    const info = buildShareUrl(xml, origin);
    const body = encodeDesignToHash(xml);

    expect(info.url).toBe(`${origin}/#${body}`);
    expect(info.url.startsWith(`${origin}/#d=`)).toBe(true);
    expect(info.url.endsWith("&v=1")).toBe(true);
    expect(info.payloadBytes).toBe(utf8Len(payloadOf(body)));
  });

  it("sets overSoft/overHard exactly at the constant boundaries", () => {
    const cases = [
      { label: "small", xml: "<system>tiny</system>", wantSoft: false, wantHard: false },
      { label: "medium", xml: randomIncompressible(16_000, 0x5eed), wantSoft: true, wantHard: false },
      { label: "large", xml: randomIncompressible(60_000, 0xbeef), wantSoft: true, wantHard: true },
    ];
    for (const c of cases) {
      const info = buildShareUrl(c.xml, origin);
      // Definitional check — holds for a correct impl regardless of exact size.
      expect(info.overSoft, `${c.label} overSoft definition`).toBe(
        info.payloadBytes > SHARE_SOFT_LIMIT_BYTES,
      );
      expect(info.overHard, `${c.label} overHard definition`).toBe(
        info.payloadBytes > SHARE_HARD_LIMIT_BYTES,
      );
      // Regime check — the three inputs straddle both boundaries.
      expect(info.overSoft, `${c.label} overSoft regime`).toBe(c.wantSoft);
      expect(info.overHard, `${c.label} overHard regime`).toBe(c.wantHard);
    }
  });
});
