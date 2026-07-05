/**
 * air-ts side of the shared XML security contract (issue #43,
 * docs/xml_security.md). Reads the SAME hostile-fixture manifest the oracle
 * reads (tests/xml_security/manifest.json) and asserts each fixture is REJECTED
 * with the manifest's SEC- code. The oracle re-checks the same fixtures in
 * tests/test_xml_security.py; the manifest is the single source of truth.
 *
 * Byte-level fixtures (oversized, utf16) are fed through parseOutcomeBytes /
 * decodeXmlBytes so the UTF-8-only encoding gate runs on raw bytes exactly as it
 * does in the oracle. Text fixtures go through parseOutcome.
 *
 * Acceptance: billion-laughs must reject in < 100 ms (before expansion).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseOutcome,
  parseOutcomeBytes,
  MAX_INPUT_BYTES,
  MAX_ATTR_COUNT,
  MAX_ATTR_VALUE_LEN,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/air-ts/tests -> repo root is three levels up. */
const SECURITY_ROOT = join(HERE, "..", "..", "..", "tests", "xml_security");

interface Fixture {
  name: string;
  file?: string;
  generated?: string;
  expect_code: string;
  note: string;
}

const manifest = JSON.parse(
  readFileSync(join(SECURITY_ROOT, "manifest.json"), "utf-8"),
) as { fixtures: Fixture[] };

const encoder = new TextEncoder();

/** Build the in-test hostile inputs too big / binary to commit. */
function generate(kind: string): Uint8Array {
  if (kind === "oversized") {
    const pad = "x".repeat(MAX_INPUT_BYTES + 1);
    return encoder.encode(`<system name="${pad}" ir_version="0.1"></system>`);
  }
  if (kind === "utf16") {
    // UTF-16-LE with a BOM.
    const doc = '<?xml version="1.0"?><system name="t" ir_version="0.1"></system>';
    const bytes = new Uint8Array(2 + doc.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < doc.length; i++) {
      const cp = doc.charCodeAt(i);
      bytes[2 + i * 2] = cp & 0xff;
      bytes[2 + i * 2 + 1] = (cp >> 8) & 0xff;
    }
    return bytes;
  }
  if (kind === "many_attributes") {
    const attrs = Array.from({ length: MAX_ATTR_COUNT + 1 }, (_, i) => `a${i}="1"`).join(" ");
    return encoder.encode(`<system ${attrs}></system>`);
  }
  if (kind === "long_attr_value") {
    const val = "y".repeat(MAX_ATTR_VALUE_LEN + 1);
    return encoder.encode(`<system name="${val}" ir_version="0.1"></system>`);
  }
  throw new Error(`unknown generated fixture: ${kind}`);
}

/** Read a committed fixture as raw bytes. */
function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(SECURITY_ROOT, rel)));
}

describe("XML security contract: hostile fixtures rejected with spec'd SEC codes", () => {
  for (const f of manifest.fixtures) {
    it(`${f.name} -> ${f.expect_code}`, () => {
      const bytes = f.file ? fixtureBytes(f.file) : generate(f.generated as string);
      const out = parseOutcomeBytes(bytes);
      expect(out.status, `${f.name}: ${f.note}`).toBe("reject");
      if (out.status === "reject") {
        expect(out.codes).toContain(f.expect_code);
      }
    });
  }
});

describe("billion-laughs timing", () => {
  it("rejects before expansion, in under 100 ms", () => {
    const bytes = fixtureBytes("fixtures/billion_laughs.air.xml");
    const t0 = performance.now();
    const out = parseOutcomeBytes(bytes);
    const elapsed = performance.now() - t0;
    expect(out.status).toBe("reject");
    if (out.status === "reject") expect(out.codes).toContain("SEC-001");
    expect(elapsed, `took ${elapsed.toFixed(3)} ms`).toBeLessThan(100);
  });
});

describe("benign input is unaffected by the security gate", () => {
  it("a UTF-8 BOM is tolerated (byte path)", () => {
    const doc = '<system name="t" ir_version="0.1"></system>';
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(doc)]);
    const out = parseOutcomeBytes(withBom);
    expect(out.status).toBe("accept");
  });

  it("a normal design still parses (text path)", () => {
    const out = parseOutcome('<system name="t" ir_version="0.1"></system>');
    expect(out.status).toBe("accept");
  });
});
