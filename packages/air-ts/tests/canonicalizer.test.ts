/**
 * Canonicalizer edge-case parity (issue #7 deliverable 5). Corpus designs cover
 * the happy path; these cases pin the minidom-serialization details that break
 * byte-parity if wrong:
 *   - self-closing empty elements (<digital/>)
 *   - attribute sort + SECTION_ORDER reorder + id-sorted sections
 *   - comment dropping (ElementTree default)
 *   - text/attribute entity escaping (& < > and " in attrs)
 *   - unicode preserved raw (not \u-escaped) in XML output
 *   - numeric char refs resolved to text
 *   - unknown sections kept and appended after known ones
 *   - whitespace-only text preserved inline
 *   - single-quote left literal in attributes
 *
 * PROVENANCE: expected `canonical` strings are the Python oracle's
 * canonicalize_tree output for each `xml` (tests/fixtures/canon_edge.json).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize } from "../src/index.js";
import { byteDiff } from "./harness.js";

interface CanonCase {
  xml: string;
  canonical: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(
  readFileSync(join(HERE, "fixtures", "canon_edge.json"), "utf-8"),
) as Record<string, CanonCase>;

describe("canonicalizer edge cases (oracle parity)", () => {
  for (const [name, c] of Object.entries(cases)) {
    it(`${name}`, () => {
      const actual = canonicalize(c.xml);
      const diff = byteDiff(actual, c.canonical, name);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
