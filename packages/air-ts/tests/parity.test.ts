/**
 * Corpus parity suite (issue #7 deliverable 6). For EVERY golden-corpus design:
 *   - parse(input) -> serializeModel === model.json          (byte-diff)
 *   - canonicalize(input) === canonical.air.xml              (byte-diff)
 *
 * These are strict byte comparisons, not `toMatchObject` / structural checks
 * (AGENTS.md rule 4 / issue guardrail). A single changed byte fails the test.
 *
 * Diagnostics scope (honest): the corpus `diagnostics.json` files mix
 * parser-level and validation-level codes, but per the diagnostics registry
 * EVERY code is owned by validation/simulator/spice/runners -- NONE by the
 * parser. All 15 designs (including the 6 "failing" ones) parse successfully and
 * emit model.json + canonical.air.xml; their failures are validation/ERC issues,
 * which are issue #8's scope. So there are no parser-level diagnostic codes to
 * assert here; this suite verifies that all 15 parse without error and match the
 * two deterministic parser artifacts. See diagnostics_scope.test.ts for the
 * explicit assertion of that scoping.
 */

import { describe, it, expect } from "vitest";
import { parse, canonicalize, serializeModel } from "../src/index.js";
import { discoverDesigns, readText, byteDiff } from "./harness.js";

const designs = discoverDesigns();

it("discovers the full corpus (>= 15 designs)", () => {
  expect(designs.length).toBeGreaterThanOrEqual(15);
});

describe("corpus parity: model.json is byte-identical", () => {
  for (const design of designs) {
    it(`${design.name} model.json`, () => {
      const input = readText(design.inputPath);
      const expected = readText(design.modelPath);
      const actual = serializeModel(parse(input));
      const diff = byteDiff(actual, expected, `${design.name}/model.json`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

describe("corpus parity: canonical.air.xml is byte-identical", () => {
  for (const design of designs) {
    it(`${design.name} canonical.air.xml`, () => {
      const input = readText(design.inputPath);
      const expected = readText(design.canonicalPath);
      const actual = canonicalize(input);
      const diff = byteDiff(actual, expected, `${design.name}/canonical.air.xml`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
