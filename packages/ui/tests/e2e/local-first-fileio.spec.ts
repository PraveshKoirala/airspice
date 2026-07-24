/**
 * AC#5 — Save-to-disk then Open-from-disk round-trips XML BYTE-EXACTLY
 * (Playwright / real Chromium).
 *
 * MECHANISM NOTE: Playwright's Chromium runs on http://127.0.0.1 (a secure
 * context), so it DOES expose the native File System Access API
 * (`showOpenFilePicker` / `showSaveFilePicker`). Playwright cannot drive those
 * native OS pickers, so this spec DISABLES FSA before the app loads
 * (`disableFsa`) to force the app's feature detection down the download-blob /
 * <input type=file> FALLBACK — the path Playwright can drive end-to-end. The
 * FSA branch of `fileIo` is exercised deterministically (with the same byte-
 * exactness assertions) by the `fileio_roundtrip.test.ts` unit test, so this
 * e2e correctly and completely covers the fallback.
 *
 * `fileIo.isFileSystemAccessSupported()` tests `"showOpenFilePicker" in window`,
 * so the property must be REMOVED (not set to undefined — `in` would still be
 * true). WebIDL exposes these operations on `Window.prototype`, so we walk the
 * prototype chain and delete wherever the property lives.
 */

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Distinctive bytes: a Greek µ and a trailing newline make byte-equality real.
const KNOWN_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n<system name="fileio_roundtrip_µ" ir_version="0.1">\n  <nets><net id="gnd" role="ground"/></nets>\n  <components/>\n  <simulation_profiles/>\n</system>\n`;

/** Force the app onto the download/<input> fallback by removing FSA globals. */
async function disableFsa(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ["showOpenFilePicker", "showSaveFilePicker"]) {
      // Walk the prototype chain (WebIDL puts these on Window.prototype) and
      // delete every own copy, so `name in window` becomes false.
      let obj: unknown = window;
      while (obj) {
        if (Object.prototype.hasOwnProperty.call(obj, name)) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            delete (obj as any)[name];
          } catch {
            /* non-configurable — ignore */
          }
        }
        obj = Object.getPrototypeOf(obj);
      }
    }
  });
}

async function seedProject(page: Page, name: string, xml: string): Promise<string> {
  await page.goto("/tests/browser/harness/index.html");
  await page.waitForFunction(() => (window as any).__storage !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("AirSpiceDB");
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__storage !== undefined);
  return page.evaluate(
    async ({ n, x }) => {
      const s = (window as any).__storage.useProjectStore;
      await s.getState().init();
      return s.getState().createProject(n, x);
    },
    { n: name, x: xml },
  );
}

async function readAll(page: Page): Promise<Array<{ id: string; xml: string }>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("AirSpiceDB");
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction("projects", "readonly").objectStore("projects").getAll();
          g.onsuccess = () => resolve(g.result);
          g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

test.describe("AC#5 file I/O byte-exact round-trip (fallback path)", () => {
  test("Save (download) then Open (input) round-trips the XML exactly", async ({ page }) => {
    await disableFsa(page);
    const seedId = await seedProject(page, "RoundTrip", KNOWN_XML);
    await page.goto("/project");
    await expect(page.locator(".project-list-item:has-text('RoundTrip')").first()).toBeVisible();

    // Guard: confirm the app really is on the fallback path (FSA removed).
    const fsa = await page.evaluate(() => "showSaveFilePicker" in window || "showOpenFilePicker" in window);
    expect(fsa).toBe(false);

    // --- Save: the fallback triggers a download blob. ---
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator('button[title="Save Design"]').click(),
    ]);
    const path = await download.path();
    const saved = readFileSync(path!, "utf-8");
    expect(saved).toBe(KNOWN_XML); // byte-exact save

    // --- Open: import the downloaded file back through the fallback input. ---
    await page.locator(".sidebar-create-btn").click();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByText("Import XML File...").click(),
    ]);
    await chooser.setFiles(path!);

    // A distinct project now exists carrying the exact same bytes.
    await expect
      .poll(async () => {
        const all = await readAll(page);
        return all.filter((r) => r.xml === KNOWN_XML && r.id !== seedId).length;
      }, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
  });
});
