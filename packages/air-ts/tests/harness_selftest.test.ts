/**
 * Parity-harness mutation self-test (issue #7 post-audit amendment 1).
 *
 * A parity harness that silently normalizes (whitespace, float re-formatting,
 * key reordering) before comparing is parity theater. This test proves the
 * teeth: it takes a real serialized output, corrupts exactly one byte in memory,
 * and asserts `byteDiff` reports a mismatch AND that a full parity assertion
 * built on it fails. If the harness ever starts comparing through any
 * normalization, one of these assertions breaks.
 */

import { describe, it, expect } from "vitest";
import { parse, canonicalize, serializeModel } from "../src/index.js";
import { discoverDesigns, readText, byteDiff } from "./harness.js";

const designs = discoverDesigns();

/** Flip one character mid-string (XOR 0x20 to guarantee a real change). */
function corruptOneByte(s: string): string {
  const idx = Math.floor(s.length / 2);
  const code = s.charCodeAt(idx);
  const flipped = String.fromCharCode(code ^ 0x20);
  return s.slice(0, idx) + flipped + s.slice(idx + 1);
}

describe("harness mutation self-test", () => {
  const design = designs[0];

  it("has at least one design to mutate", () => {
    expect(design).toBeDefined();
  });

  it("byteDiff detects a one-byte corruption of model.json", () => {
    if (!design) return;
    const good = serializeModel(parse(readText(design.inputPath)));
    const corrupted = corruptOneByte(good);
    // Sanity: the corruption actually changed the string.
    expect(corrupted).not.toBe(good);
    // The harness MUST see them as unequal (no normalization swallowing it).
    const diff = byteDiff(corrupted, good, "self-test/model.json");
    expect(diff.equal).toBe(false);
    expect(diff.firstDiffIndex).toBeGreaterThanOrEqual(0);
  });

  it("byteDiff detects a one-byte corruption of canonical.air.xml", () => {
    if (!design) return;
    const good = canonicalize(readText(design.inputPath));
    const corrupted = corruptOneByte(good);
    expect(corrupted).not.toBe(good);
    const diff = byteDiff(corrupted, good, "self-test/canonical.air.xml");
    expect(diff.equal).toBe(false);
  });

  it("a parity assertion built on byteDiff FAILS on the corrupted output", () => {
    if (!design) return;
    const expected = readText(design.modelPath);
    const actual = corruptOneByte(serializeModel(parse(readText(design.inputPath))));
    const diff = byteDiff(actual, expected, "self-test");
    // This is exactly the assertion parity.test.ts makes; here it must be false.
    expect(diff.equal).toBe(false);
  });

  it("byteDiff reports equal for an untouched round-trip (control)", () => {
    if (!design) return;
    const good = serializeModel(parse(readText(design.inputPath)));
    const diff = byteDiff(good, good, "self-test/control");
    expect(diff.equal).toBe(true);
    expect(diff.firstDiffIndex).toBe(-1);
  });
});
