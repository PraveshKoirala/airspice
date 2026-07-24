/**
 * Issue #28 — onboarding gallery THUMBNAILS acceptance (unit).
 *
 * The PRD requires thumbnails to be REAL, design-derived renders produced by
 * air-ts `toSchematicSvg` (added in #40) — NOT stock art and NOT a fixed
 * placeholder. "Same design in → same bytes out; different design → different
 * bytes; and the SVG reflects that design's components."
 *
 * We compute the expected thumbnails DIRECTLY from air-ts here, so:
 *   • a fixed-string / placeholder thumbnail fails (two designs would render
 *     identical bytes → the distinctness assertion fails);
 *   • stock art fails (the SVG would not contain the design's component ids).
 *
 * The e2e suite (onboarding.spec.ts) separately proves the Landing cards
 * actually render THESE SVGs (inline <svg>, distinct across cards).
 */

import { describe, expect, it } from "vitest";
import { toSchematicSvg } from "air-ts";
import { loadGallery, readExampleXml, resolveSourcePath } from "./_galleryFixture";
import { readFileSync } from "node:fs";

// Two DIFFERENT real designs with disjoint component ids.
const ANALOG = readExampleXml("examples/analog_primitives/design.air.xml");
const ESP32 = readExampleXml("examples/esp32_battery_sensor/design.air.xml");

// Component ids unique to each design (used to prove the render is derived from
// THAT design, not a generic template).
const ANALOG_ONLY = ["V_IN", "LOAD_A"];
const ESP32_ONLY = ["U_MCU", "C_BAT_SENSE"];

function textNodeCount(svg: string): number {
  return (svg.match(/<text\b/g) ?? []).length;
}

describe("air-ts toSchematicSvg produces real, design-derived thumbnails", () => {
  const svgAnalog = toSchematicSvg(ANALOG);
  const svgEsp = toSchematicSvg(ESP32);

  it("renders a non-trivial SVG document", () => {
    for (const svg of [svgAnalog, svgEsp]) {
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
      expect(svg.length).toBeGreaterThan(400);
      // A real schematic has many labelled elements (component ids, pins, nets).
      expect(textNodeCount(svg)).toBeGreaterThanOrEqual(4);
    }
  });

  it("is DETERMINISTIC — same design in, same bytes out", () => {
    expect(toSchematicSvg(ANALOG)).toBe(svgAnalog);
    expect(toSchematicSvg(ESP32)).toBe(svgEsp);
  });

  it("two different designs render DISTINCT SVGs (a fixed placeholder fails)", () => {
    expect(svgAnalog).not.toBe(svgEsp);
  });

  it("each SVG reflects ITS OWN design's components (stock art fails)", () => {
    for (const id of ANALOG_ONLY) {
      expect(svgAnalog, `analog thumbnail must contain ${id}`).toContain(id);
      expect(svgEsp, `esp32 thumbnail must NOT contain analog-only ${id}`).not.toContain(id);
    }
    for (const id of ESP32_ONLY) {
      expect(svgEsp, `esp32 thumbnail must contain ${id}`).toContain(id);
      expect(svgAnalog, `analog thumbnail must NOT contain esp32-only ${id}`).not.toContain(id);
    }
  });
});

describe("every gallery entry renders a real, distinct thumbnail", () => {
  const { path, entries } = loadGallery();

  it("each entry's design renders a non-trivial SVG without throwing", () => {
    for (const e of entries) {
      const resolved = resolveSourcePath(e.sourcePath, path);
      expect(resolved, `sourcePath for ${e.id}`).not.toBeNull();
      const xml = readFileSync(resolved as string, "utf8");
      const svg = toSchematicSvg(xml);
      expect(svg.startsWith("<svg"), `${e.id} → <svg>`).toBe(true);
      expect(textNodeCount(svg), `${e.id} → labelled elements`).toBeGreaterThanOrEqual(1);
    }
  });

  it("the set of thumbnails is NOT all identical (kills a fixed placeholder)", () => {
    const rendered = entries.map((e) => {
      const resolved = resolveSourcePath(e.sourcePath, path);
      return toSchematicSvg(readFileSync(resolved as string, "utf8"));
    });
    const distinct = new Set(rendered);
    expect(distinct.size, "at least two distinct thumbnails across the gallery").toBeGreaterThanOrEqual(2);
  });
});
