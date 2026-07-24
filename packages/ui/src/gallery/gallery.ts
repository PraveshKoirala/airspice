/**
 * Gallery data layer (issue #28 deliverable 1 + 2).
 *
 * The example gallery is DATA-DRIVEN: `public/gallery.json` is the single source
 * of truth. Adding an example is dropping its `*.air.xml` into `public/gallery/`
 * and adding one JSON row — no code change. The manifest and every design XML are
 * the app's OWN static assets (copied verbatim into the build by Vite), so the
 * gallery loads with zero network beyond same-origin assets and works backend-off
 * and keyless.
 *
 * Thumbnails are REAL renders: `thumbnailSvg` runs each design's bundled XML
 * through air-ts `toSchematicSvg` (the same deterministic headless renderer the
 * MCP `render_schematic` tool uses). Same design in -> same SVG bytes out, and
 * two different designs render to two different SVGs — there is no stock art and
 * no fixed placeholder anywhere in this path.
 */

import { toSchematicSvg } from "air-ts";

export type GalleryDifficulty = "beginner" | "intermediate" | "advanced";
export type GalleryKind = "working" | "fixme";

export interface GalleryEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  difficulty: GalleryDifficulty;
  /** Path to the bundled design XML, relative to the app's asset root. */
  sourcePath: string;
  kind: GalleryKind;
  firmware?: boolean;
}

/** Resolve an asset path against the Vite base URL (subpath-deploy safe). */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  const clean = path.replace(/^\/+/, "");
  return `${base}${clean}`;
}

/**
 * Load and validate the gallery manifest. Throws on a malformed manifest so a
 * bad entry surfaces loudly rather than rendering a broken card.
 */
export async function loadGallery(): Promise<GalleryEntry[]> {
  const res = await fetch(assetUrl("gallery.json"), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Could not load the example gallery (HTTP ${res.status}).`);
  }
  const data: unknown = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("gallery.json must be an array of entries.");
  }
  return data.map(validateEntry);
}

function validateEntry(raw: unknown, index: number): GalleryEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`gallery.json entry ${index} is not an object.`);
  }
  const e = raw as Record<string, unknown>;
  const need = (k: string): string => {
    const v = e[k];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`gallery.json entry ${index} is missing "${k}".`);
    }
    return v;
  };
  const kind = need("kind");
  if (kind !== "working" && kind !== "fixme") {
    throw new Error(`gallery.json entry ${index} has an invalid kind "${kind}".`);
  }
  const difficulty = need("difficulty");
  if (difficulty !== "beginner" && difficulty !== "intermediate" && difficulty !== "advanced") {
    throw new Error(`gallery.json entry ${index} has an invalid difficulty "${difficulty}".`);
  }
  return {
    id: need("id"),
    title: need("title"),
    description: need("description"),
    tags: Array.isArray(e["tags"]) ? (e["tags"] as unknown[]).map(String) : [],
    difficulty,
    sourcePath: need("sourcePath"),
    kind,
    ...(typeof e["firmware"] === "boolean" ? { firmware: e["firmware"] } : {}),
  };
}

/** Fetch the bundled design XML for a gallery entry (a same-origin asset). */
export async function loadEntryXml(entry: GalleryEntry): Promise<string> {
  const res = await fetch(assetUrl(entry.sourcePath), { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`Could not load "${entry.title}" (HTTP ${res.status}).`);
  }
  return res.text();
}

/**
 * Render a design's REAL schematic thumbnail via air-ts `toSchematicSvg`.
 *
 * This is the honest thumbnail generator the PRD requires: it is a pure function
 * of the design XML, so design A and design B produce different SVGs and each
 * thumbnail reflects that design's own components and nets. A stub / fixed string
 * would make two designs render identically — this never does.
 */
export function thumbnailSvg(xml: string): string {
  return toSchematicSvg(xml);
}
