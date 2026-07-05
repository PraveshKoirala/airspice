/**
 * Diagnostics parity suite (issue #8 deliverable 4). For EVERY golden-corpus
 * design:
 *   validateToJson(input) === diagnostics.json      (strict byte-diff)
 *
 * This is the contract: the serialized {success, diagnostics:[...]} payload must
 * be byte-identical to the fixture the oracle froze via
 *   diagnostics = validate_tree(tree) + validate_ir(ir)
 *   dumps({"success": not has_errors(diagnostics),
 *          "diagnostics": [d.to_dict() for d in diagnostics]})
 * A single changed byte -- a reordered diagnostic, a wrong id, a `%.3g` that
 * rounds differently, a missing observed/expected key -- fails the test
 * (AGENTS.md rule 4: no toMatchObject, no "close enough").
 *
 * Design names are discovered dynamically from the corpus (harness.ts); no
 * design name is hard-coded here (guardrails R4 / AGENTS.md rule 13).
 */

import { describe, it, expect } from "vitest";
import { validateToJson } from "../src/index.js";
import { discoverDesigns, readText, byteDiff } from "./harness.js";
import { existsSync } from "node:fs";

const designs = discoverDesigns();

it("discovers the full corpus (>= 15 designs)", () => {
  expect(designs.length).toBeGreaterThanOrEqual(15);
});

describe("corpus parity: diagnostics.json is byte-identical", () => {
  for (const design of designs) {
    it(`${design.name} diagnostics.json`, () => {
      // Every committed design parses (no parser-level refusal); a design with
      // no diagnostics.json fixture would be a parse_error case (error.json),
      // which the corpus does not currently contain.
      expect(existsSync(design.diagnosticsPath), `${design.name} has diagnostics.json`).toBe(true);
      const input = readText(design.inputPath);
      const expected = readText(design.diagnosticsPath);
      const actual = validateToJson(input);
      const diff = byteDiff(actual, expected, `${design.name}/diagnostics.json`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
