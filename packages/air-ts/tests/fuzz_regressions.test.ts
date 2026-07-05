/**
 * air-ts side of the fuzzer regression corpus (issue #43 deliverable 4).
 *
 * The differential fuzzer (scripts/fuzz_diff.mjs) archives every shrunk
 * divergence under tests/fuzz_regressions/ as <name>.air.xml + <name>.json
 * (the recorded air-ts / oracle outcomes and the filed issue). This test
 * re-evaluates air-ts's HALF of each fixture and asserts it still produces the
 * recorded outcome, so a change to the parser that would move a divergence is
 * caught here (the oracle re-checks its half in tests/test_fuzz_regressions.py).
 *
 * These fixtures are NOT the golden corpus; they intentionally include KNOWN
 * divergences (air-ts and the oracle DISAGREE until the filed issue is fixed),
 * so we pin air-ts's recorded side rather than asserting cross-engine agreement.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseOutcome } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REGRESSION_DIR = join(HERE, "..", "..", "..", "tests", "fuzz_regressions");

interface RegMeta {
  issue: string;
  expect?: string;
  diverges?: boolean;
  ts: { status: string; modelHash?: string; codes?: string[] };
  py: { status: string; modelHash?: string; codes?: string[] };
}

function fixtures(): string[] {
  return readdirSync(REGRESSION_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

describe("fuzz regression corpus (air-ts side)", () => {
  it("has at least 10 archived regressions", () => {
    expect(fixtures().length).toBeGreaterThanOrEqual(10);
  });

  for (const jsonFile of fixtures()) {
    const meta = JSON.parse(readFileSync(join(REGRESSION_DIR, jsonFile), "utf-8")) as RegMeta;
    const xmlFile = jsonFile.replace(/\.json$/, ".air.xml");
    it(`${jsonFile} (${meta.issue}): air-ts reproduces its recorded outcome`, () => {
      const xml = readFileSync(join(REGRESSION_DIR, xmlFile), "utf-8");
      const out = parseOutcome(xml);
      expect(out.status).toBe(meta.ts.status);
      if (out.status === "accept" && meta.ts.status === "accept") {
        expect(out.modelHash).toBe(meta.ts.modelHash);
      } else if (out.status === "reject" && meta.ts.status === "reject") {
        expect(out.codes.slice().sort()).toEqual((meta.ts.codes ?? []).slice().sort());
      }
      // 'accept-agree' fixtures record a FIXED divergence (e.g. #80): air-ts
      // must still agree with the oracle. If the parser fix is reverted, air-ts
      // re-diverges and this fails -- the regression guard.
      if (meta.expect === "accept-agree") {
        expect(out.status).toBe("accept");
        if (out.status === "accept") expect(out.modelHash).toBe(meta.py.modelHash);
        expect(meta.diverges).toBe(false);
      }
    });
  }
});
