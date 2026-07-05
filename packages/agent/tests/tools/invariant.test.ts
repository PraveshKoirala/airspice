/**
 * The single-write-path INVARIANT (issue #18 guardrail #1) — executable proof.
 *
 * The invariant: there is NO code path where provider output writes the design
 * without normalize + validate. It is enforced three ways; this file proves the
 * runtime + type halves, and the grep half is asserted mechanically below.
 *
 *   1. TYPE: `ValidatedDesign` is branded; only `gateDesign` constructs it. A
 *      "writer" typed to accept only `ValidatedDesign` therefore cannot be fed
 *      anything that skipped the gate — a non-gated value does not TYPE-CHECK.
 *      (The negative case is a compile-time `// @ts-expect-error` below.)
 *   2. RUNTIME: a failed gate returns `{ ok: false }` with NO `design` field, so
 *      there is nothing to write; the runtime's set_design/propose_patch stage
 *      only on `ok: true`.
 *   3. GREP: the brand symbol and the sole constructor appear in exactly one
 *      source file (validated.ts). This test greps the built source to prove the
 *      construction site is unique.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gateDesign, GOLDEN_DESIGN, type ValidatedDesign } from "../../src/index.js";
import { realAirTsEngine } from "./engineAdapter.js";

/** Recursively read every .ts source file under src/. */
function readSrcTree(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...readSrcTree(full));
    else if (entry.name.endsWith(".ts")) out.push({ path: full, text: readFileSync(full, "utf-8") });
  }
  return out;
}

/** Stand-in for the UI's SINGLE editor-state writer: accepts ONLY the gate type. */
function writeDesign(design: ValidatedDesign): string {
  return design.xml;
}

describe("single-write-path invariant", () => {
  const hooks = realAirTsEngine();

  it("a gated design is the ONLY thing the writer accepts (type-enforced)", () => {
    const result = gateDesign(GOLDEN_DESIGN, hooks);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The writer accepts the ValidatedDesign the gate produced.
      expect(writeDesign(result.design)).toContain("<system");
    }
  });

  it("a raw string cannot be written (compile-time rejection)", () => {
    // @ts-expect-error — a plain string is not a ValidatedDesign; the gate is the
    // only constructor. If this ever compiles, the invariant's type half broke.
    expect(() => writeDesign("<system>not gated</system>")).toBeDefined();
  });

  it("a hand-built object cannot be written (brand is unforgeable)", () => {
    // @ts-expect-error — an object literal lacks the private brand; only
    // gateDesign can produce a ValidatedDesign.
    const fake: ValidatedDesign = { xml: "<system/>", diagnostics: [] };
    // The line above does not compile; the runtime never reaches here in a
    // type-clean build. Assert presence so the test body is non-empty.
    expect(fake).toBeDefined();
  });

  it("a failed gate exposes NO design to write (runtime)", () => {
    const result = gateDesign("<system><broken", hooks);
    expect(result.ok).toBe(false);
    expect("design" in result).toBe(false);
  });

  it("GREP: the brand + sole constructor live in exactly one source file", () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readSrcTree(srcRoot);

    // The brand symbol is declared in exactly ONE file, exactly once.
    const brandFiles = files.filter((f) => /declare const BRAND: unique symbol/.test(f.text));
    expect(brandFiles).toHaveLength(1);
    expect(brandFiles[0]!.path.endsWith("validated.ts")).toBe(true);

    // The sole construction site — a `} as ValidatedDesign` cast expression (the
    // brace disambiguates from prose) — appears across ALL of src/ exactly once.
    let constructionSites = 0;
    for (const f of files) constructionSites += (f.text.match(/\}\s*as ValidatedDesign/g) ?? []).length;
    expect(constructionSites).toBe(1);
  });
});
