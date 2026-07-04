/**
 * Tests for the differential-fuzzer outcome reporter (issue #7 post-audit
 * amendment 2, consumed by #43). The reporter must never throw and must return a
 * stable three-variant result: accept + model hash | reject + codes | crash.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseOutcome, fnv1a64 } from "../src/index.js";
import { discoverDesigns } from "./harness.js";

describe("parseOutcome", () => {
  const designs = discoverDesigns();

  it("accepts a valid corpus design and returns a stable model hash", () => {
    const design = designs[0];
    expect(design).toBeDefined();
    if (!design) return;
    const xml = readFileSync(design.inputPath, "utf-8");
    const a = parseOutcome(xml);
    const b = parseOutcome(xml);
    expect(a.status).toBe("accept");
    expect(b).toEqual(a); // deterministic
    if (a.status === "accept") {
      expect(a.modelHash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("distinct designs generally produce distinct hashes", () => {
    const hashes = new Set<string>();
    for (const d of designs) {
      const out = parseOutcome(readFileSync(d.inputPath, "utf-8"));
      if (out.status === "accept") hashes.add(out.modelHash);
    }
    // Not a strict guarantee, but the corpus designs are all different.
    expect(hashes.size).toBeGreaterThan(1);
  });

  it("rejects a non-<system> root without throwing", () => {
    const out = parseOutcome("<notsystem/>");
    expect(out.status).toBe("reject");
    if (out.status === "reject") {
      expect(out.codes).toEqual([]); // no parser-level codes in #7
      expect(out.reason).toContain("AirParseError");
    }
  });

  it("rejects malformed XML without throwing", () => {
    const out = parseOutcome("<system><unclosed></system>");
    expect(out.status).toBe("reject");
  });

  it("rejects a DOCTYPE (security) without throwing", () => {
    const out = parseOutcome('<!DOCTYPE x><system name="t" ir_version="0.1"/>');
    expect(out.status).toBe("reject");
    if (out.status === "reject") {
      expect(out.reason).toContain("XmlSecurityError");
    }
  });
});

describe("fnv1a64", () => {
  it("is deterministic and 16 lowercase hex chars", () => {
    const h = fnv1a64("hello");
    expect(h).toBe(fnv1a64("hello"));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("differs for different inputs", () => {
    expect(fnv1a64("a")).not.toBe(fnv1a64("b"));
  });

  it("matches the known FNV-1a-64 vector for the empty string", () => {
    // FNV-1a 64-bit offset basis (empty input): 0xcbf29ce484222325.
    expect(fnv1a64("")).toBe("cbf29ce484222325");
  });
});
