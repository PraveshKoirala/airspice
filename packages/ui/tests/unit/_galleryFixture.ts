/**
 * Shared helpers for the onboarding-gallery UNIT tests (issue #28).
 *
 * These read the REAL, on-disk gallery metadata and the REAL bundled design
 * XML — no mocks, no fixtures baked into the test. The gallery is data-driven
 * (adding an entry to gallery.json must NOT require code changes), so the tests
 * iterate whatever the builder curated and hold every entry to the same bar.
 *
 * ── Stated assumptions (see the tester report; the builder matches these) ──
 *  • gallery.json lives at `packages/ui/public/gallery.json` (served at
 *    `/gallery.json`). The loader ALSO accepts `examples/gallery.json` so the
 *    test survives the alternate placement the PRD allows.
 *  • Each entry's `sourcePath` points at a REAL, parseable design XML bundled
 *    as a static asset. The resolver tries the conventional bases
 *    (public/, repo root, the gallery.json's own dir, packages/ui) so the test
 *    enforces "the file exists and parses" WITHOUT over-fitting one layout.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/ui/tests/unit
export const UI_DIR = resolve(HERE, "..", ".."); // packages/ui
export const REPO_ROOT = resolve(UI_DIR, "..", ".."); // repo root
export const PUBLIC_DIR = resolve(UI_DIR, "public");

export interface GalleryEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  sourcePath: string;
  kind: "working" | "fixme";
  firmware?: boolean;
}

/** Candidate on-disk locations for gallery.json, most-conventional first. */
const GALLERY_CANDIDATES = [
  join(PUBLIC_DIR, "gallery.json"),
  join(REPO_ROOT, "examples", "gallery.json"),
  join(UI_DIR, "gallery.json"),
  join(REPO_ROOT, "gallery.json"),
];

export function findGalleryPath(): string | null {
  return GALLERY_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export function loadGallery(): { path: string; entries: GalleryEntry[] } {
  const path = findGalleryPath();
  if (!path) {
    throw new Error(
      `gallery.json not found. Looked in:\n  ${GALLERY_CANDIDATES.join("\n  ")}`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  // Accept either a bare array or a wrapper object with an `entries`/`examples`
  // array, so the test does not over-fit the top-level shape.
  const entries: GalleryEntry[] = Array.isArray(parsed)
    ? parsed
    : (parsed.entries ?? parsed.examples ?? parsed.gallery);
  if (!Array.isArray(entries)) {
    throw new Error(`gallery.json (${path}) did not contain an entries array`);
  }
  return { path, entries };
}

/**
 * Resolve an entry's `sourcePath` to a real file on disk, trying the
 * conventional static-asset bases. Returns the absolute path or null.
 */
export function resolveSourcePath(sourcePath: string, galleryPath: string): string | null {
  const rel = sourcePath.replace(/^\/+/, ""); // strip a leading app-root slash
  const bases = [
    PUBLIC_DIR,
    REPO_ROOT,
    dirname(galleryPath),
    UI_DIR,
  ];
  const candidates = [
    ...(isAbsolute(sourcePath) ? [sourcePath] : []),
    ...bases.map((b) => join(b, rel)),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Read a repo-root-relative example design XML (for the thumbnail tests). */
export function readExampleXml(relFromRepoRoot: string): string {
  return readFileSync(join(REPO_ROOT, relFromRepoRoot), "utf8");
}
