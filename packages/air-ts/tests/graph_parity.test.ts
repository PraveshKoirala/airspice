/**
 * Corpus parity suite for the graph emitter (issue #10 deliverable 1 /
 * acceptance "corpus parity for graph JSON"). For EVERY golden-corpus design:
 *
 *   toGraphJson(input) === graph.json                          (byte-diff)
 *
 * A strict byte comparison, not `toMatchObject` / structural equality (AGENTS.md
 * rule 4 / issue guardrail "parity is byte-exact"). A single changed byte fails.
 *
 * The oracle emits graph.json for ALL 15 designs -- including the 6 "failing"
 * ones: the graph compiler runs BEFORE validation and does not require a valid
 * design (export_golden.py comment: "graph.json -- graph compiler output (does
 * not require validation)"). So every design has a graph.json fixture and every
 * design is exercised here; the parity target is what the oracle actually
 * produced, failing designs included.
 *
 * fs is used ONLY in this test file (via the harness); src/ never touches disk.
 */

import { describe, it, expect } from "vitest";
import { toGraphJson } from "../src/index.js";
import { discoverDesigns, readText, byteDiff } from "./harness.js";
import { existsSync } from "node:fs";

const designs = discoverDesigns();

it("every corpus design has a graph.json fixture", () => {
  // The graph compiler runs for all designs (valid AND failing), so every
  // discovered design must ship a graph.json -- guards against a design being
  // silently skipped by this suite.
  const missing = designs.filter((d) => !existsSync(d.graphPath)).map((d) => d.name);
  expect(missing, `designs with NO graph.json: [${missing.join(", ")}]`).toEqual([]);
  expect(designs.length).toBeGreaterThanOrEqual(15);
});

describe("corpus parity: graph.json is byte-identical", () => {
  for (const design of designs) {
    it(`${design.name} graph.json`, () => {
      const input = readText(design.inputPath);
      const expected = readText(design.graphPath);
      const actual = toGraphJson(input);
      const diff = byteDiff(actual, expected, `${design.name}/graph.json`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
