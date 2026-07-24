/**
 * Issue #28 — onboarding gallery METADATA acceptance (unit).
 *
 * Encodes the PRD bar: "gallery.json parses and every entry's sourcePath
 * resolves to a real bundled design XML." The gallery is data-driven, so we
 * iterate whatever the builder curated and hold every entry to the same rules.
 *
 * How this kills a stub: a hardcoded-cards gallery (cards baked into JSX with
 * no backing JSON, or entries whose `sourcePath` is fabricated / points at
 * nothing) fails here — either gallery.json is absent, or a sourcePath does not
 * resolve to a real file that air-ts can parse into a non-empty design.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, validate } from "air-ts";
import { loadGallery, resolveSourcePath } from "./_galleryFixture";

const DIFFICULTIES = new Set(["beginner", "intermediate", "advanced"]);
const KINDS = new Set(["working", "fixme"]);

describe("gallery.json metadata", () => {
  const { path, entries } = loadGallery();

  it("parses to a non-trivial array of entries", () => {
    expect(Array.isArray(entries)).toBe(true);
    // A real curated set drawn from examples/ + samples/ + examples/failing/*.
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  it("has both a Working row and a Fix-me row", () => {
    const working = entries.filter((e) => e.kind === "working");
    const fixme = entries.filter((e) => e.kind === "fixme");
    expect(working.length, "at least one kind:working entry").toBeGreaterThanOrEqual(1);
    expect(fixme.length, "at least one kind:fixme entry").toBeGreaterThanOrEqual(1);
  });

  it("every entry has the required, well-typed fields", () => {
    for (const e of entries) {
      const where = `entry ${JSON.stringify(e.id ?? e)}`;
      expect(typeof e.id, `${where}: id`).toBe("string");
      expect(e.id.length, `${where}: id non-empty`).toBeGreaterThan(0);
      expect(typeof e.title, `${where}: title`).toBe("string");
      expect(e.title.length, `${where}: title non-empty`).toBeGreaterThan(0);
      expect(typeof e.description, `${where}: description`).toBe("string");
      expect(e.description.length, `${where}: description non-empty`).toBeGreaterThan(0);
      expect(Array.isArray(e.tags), `${where}: tags[]`).toBe(true);
      expect(DIFFICULTIES.has(e.difficulty), `${where}: difficulty=${e.difficulty}`).toBe(true);
      expect(KINDS.has(e.kind), `${where}: kind=${e.kind}`).toBe(true);
      expect(typeof e.sourcePath, `${where}: sourcePath`).toBe("string");
      expect(e.sourcePath.length, `${where}: sourcePath non-empty`).toBeGreaterThan(0);
    }
  });

  it("entry ids are unique", () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size, "no duplicate ids").toBe(ids.length);
  });

  it("every sourcePath resolves to a real design XML that air-ts parses into a non-empty design", () => {
    for (const e of entries) {
      const resolved = resolveSourcePath(e.sourcePath, path);
      expect(resolved, `sourcePath for "${e.id}" (${e.sourcePath}) must resolve to a real file`).not.toBeNull();

      // The file must be a genuine, parseable AIR design — a stub empty file or
      // a non-design asset fails here.
      const xml = readFileSync(resolved as string, "utf8");
      const ir = parse(xml);
      expect(ir.components.size, `design "${e.id}" must have components`).toBeGreaterThan(0);
    }
  });

  // The real semantic distinction — NOT a path-string convention. Bundled
  // designs are served from the app's own static assets (e.g. /gallery/*.xml),
  // so the sourcePath string is not a reliable "is this the repair set?" signal.
  // Instead: a Fix-me entry must be a genuinely BROKEN (repairable) design —
  // air-ts validate() reports >=1 error-severity diagnostic — while a Working
  // entry validates CLEAN. This cannot pass for a working design mislabeled
  // fixme, nor a broken design mislabeled working.
  it("Fix-me entries are genuinely broken (repair-demo) designs; Working entries validate clean", () => {
    for (const e of entries) {
      const resolved = resolveSourcePath(e.sourcePath, path);
      expect(resolved, `sourcePath for "${e.id}"`).not.toBeNull();
      const xml = readFileSync(resolved as string, "utf8");
      const errors = validate(xml).filter((d) => d.severity === "error");

      if (e.kind === "fixme") {
        expect(
          errors.length,
          `Fix-me "${e.id}" must be a broken/repairable design (>=1 error-severity diagnostic)`,
        ).toBeGreaterThanOrEqual(1);
      } else {
        expect(
          errors.length,
          `Working "${e.id}" must validate clean; got errors [${errors.map((d) => d.code).join(", ")}]`,
        ).toBe(0);
      }
    }
  });
});
