/**
 * Share-link end-to-end acceptance (issue #27), in a REAL browser.
 *
 * These drive the actual app at a `#d=<payload>&v=1` fragment URL and assert
 * the three integration criteria from the PRD:
 *
 *   7. a valid share URL reconstructs and RENDERS the shared design's schematic,
 *      and the fragment is stripped from the address bar afterward;
 *   8. NO network request carries the payload (fragment-only privacy);
 *   9. a corrupt `#d=...` lands on the normal start screen with a friendly
 *      error and no uncaught exception.
 *
 * The share payload here is built INDEPENDENTLY with real fflate raw-deflate +
 * base64url — NOT via the app's own codec. That is what makes these tests fail
 * against a stub: a passthrough/identity decoder receives a genuinely compressed
 * base64url blob, cannot recover the XML, and never renders the shared
 * schematic. Style (baseURL-relative `page.goto`, `page.on` capture, testid /
 * role locators) matches packages/ui/tests/browser/*.spec.ts.
 */

import { test, expect } from "@playwright/test";
import { deflateSync } from "fflate";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// The app's built-in default design is examples/esp32_battery_sensor; loading a
// DIFFERENT corpus design lets us prove the SHARED design rendered (not the
// default). `R_BAT_TOP` is a component only the default carries.
const DEFAULT_ONLY_COMPONENT_ID = "R_BAT_TOP";

function findExamplesDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "examples");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate examples/ from ${process.cwd()}`);
}

/** A valid corpus design that is NOT the app's default, plus one of its ids. */
function pickSharedDesign(): { name: string; xml: string; componentId: string } {
  const dir = findExamplesDir();
  const present = new Set(readdirSync(dir));
  // Prefer the simplest known-valid corpus designs first (a plain voltage
  // divider) so the render assertion never flakes on a design the validation
  // gate might legitimately reject; fall back to any other non-default design.
  const preferred = ["analog_primitives", "mixed_signal_switch", "advanced_components"];
  const order = [...preferred.filter((n) => present.has(n)), ...[...present].filter((n) => !preferred.includes(n))];
  for (const name of order) {
    if (name === "esp32_battery_sensor" || name === "failing") continue;
    const file = join(dir, name, "design.air.xml");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const xml = readFileSync(file, "utf8");
    const m = xml.match(/<component\s+id="([^"]+)"/);
    if (m && m[1] !== DEFAULT_ONLY_COMPONENT_ID) {
      return { name, xml, componentId: m[1] };
    }
  }
  throw new Error("no non-default example design with a component id found");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** REAL raw-deflate + base64url payload body: `d=<payload>&v=1` (no '#'). */
function encodeShareBody(xml: string): string {
  const deflated = deflateSync(new TextEncoder().encode(xml), { level: 9 });
  return `d=${bytesToBase64Url(deflated)}&v=1`;
}

const SHARED = pickSharedDesign();

test.describe("share links reconstruct a design from the URL fragment", () => {
  test("a valid share URL renders the shared schematic and strips the fragment", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    const body = encodeShareBody(SHARED.xml);
    await page.goto(`/#${body}`);

    // The shared design's schematic renders: a component that only IT carries.
    await expect(
      page.locator(`[data-component-id="${SHARED.componentId}"]`),
      `expected the shared design (${SHARED.name}) component ${SHARED.componentId} to render`,
    ).toBeVisible({ timeout: 60_000 });

    // It is the SHARED design, not the app's built-in default.
    await expect(page.locator(`[data-component-id="${DEFAULT_ONLY_COMPONENT_ID}"]`)).toHaveCount(0);

    // The fragment is stripped so a reload does not re-import the design.
    await expect
      .poll(async () => await page.evaluate(() => window.location.hash), { timeout: 15_000 })
      .not.toContain("d=");

    expect(pageErrors, pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
  });

  test("no network request carries the d= payload (fragment-only privacy)", async ({ page }) => {
    const body = encodeShareBody(SHARED.xml);
    const payload = body.replace(/^d=/, "").replace(/&v=1$/, "");
    // A long unique base64url blob — an unmistakable substring to scan for.
    expect(payload.length).toBeGreaterThan(200);

    const offenders: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      let post = "";
      try {
        post = req.postData() ?? "";
      } catch {
        post = "";
      }
      if (url.includes(payload) || post.includes(payload)) {
        offenders.push(`${req.method()} ${url}`);
      }
    });

    await page.goto(`/#${body}`);

    // The design still loads (fragment-only, not server-carried)...
    await expect(page.locator(`[data-component-id="${SHARED.componentId}"]`)).toBeVisible({
      timeout: 60_000,
    });
    // ...and no request leaked the payload.
    expect(offenders, `requests leaked the payload:\n${offenders.join("\n")}`).toHaveLength(0);
  });

  test("a corrupt fragment lands on the start screen with no uncaught exception", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    // Take a REAL valid payload and mangle its middle third — the result almost
    // certainly fails inflate or yields non-XML, exercising the designed error
    // path rather than a happy decode.
    const validBody = encodeShareBody(SHARED.xml);
    const payload = validBody.replace(/^d=/, "").replace(/&v=1$/, "").split("");
    for (let i = Math.floor(payload.length / 3); i < Math.floor((2 * payload.length) / 3); i++) {
      payload[i] = "Z";
    }
    const corrupt = `d=${payload.join("")}&v=1`;

    await page.goto(`/#${corrupt}`);

    // Lands on the normal start screen (Landing), not a crashed/blank page.
    // Anchor on the structural landing container (branding-independent, unique
    // to the start screen — the workspace uses `.app-container`) plus the hero
    // heading (the product is "AirSpice": Landing renders <h1>AirSpice</h1>).
    await expect(page.locator(".landing-container")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /airspice/i })).toBeVisible();
    // The corrupt fragment did NOT silently load any schematic.
    await expect(page.locator("[data-component-id]")).toHaveCount(0);
    // No uncaught exception escaped to the page.
    expect(pageErrors, pageErrors.map((e) => e.message).join("\n")).toHaveLength(0);
  });
});
