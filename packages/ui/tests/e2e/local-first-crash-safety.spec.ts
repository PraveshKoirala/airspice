/**
 * AC#1 — Autosave + crash-safety (Playwright / real Chromium, real IndexedDB).
 *
 * "Edits autosave to IndexedDB debounced ~1s after the last edit, PLUS an
 *  immediate flush on `visibilitychange`->hidden and `pagehide`. A mid-edit hard
 *  reload recovers the last autosaved state (no lost work)."
 *
 * These tests drive the REAL app at `/project`: they type a unique marker into
 * the live XML editor (which routes through the app's autosave wiring), then
 * verify the marker survives a hard reload — first via the ~1s debounce, then
 * via an immediate `pagehide` flush BEFORE the debounce could fire.
 *
 * The design store is not exposed on `/project`, so state is inspected straight
 * from IndexedDB (the source of truth) via `page.evaluate`.
 */

import { test, expect, type Page } from "@playwright/test";

const DB_NAME = "AirSpiceDB";

/** Read every project record straight out of IndexedDB (source of truth). */
async function readAllProjects(page: Page): Promise<Array<{ id: string; xml: string; name: string }>> {
  return page.evaluate((dbName) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("projects")) return resolve([]);
        const tx = db.transaction("projects", "readonly");
        const all = tx.objectStore("projects").getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
  }, DB_NAME);
}

async function createBlankProject(page: Page): Promise<void> {
  await page.locator(".sidebar-create-btn").click();
  await page.getByText("Blank Project", { exact: true }).click();
  await expect(page.locator(".project-list-item").first()).toBeVisible();
}

/** Insert a unique single-line marker into the live Monaco editor. */
async function typeMarkerIntoEditor(page: Page, marker: string): Promise<void> {
  await page.locator(".sidebar-tab").filter({ hasText: /^AIR XML$/ }).click();
  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  // Jump to the very start and insert a comment marker on its own line. A single
  // inserted line is not reflowed by auto-indent, so the marker bytes survive.
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(`<!--${marker}-->\n`);
}

test.describe("AC#1 autosave crash-safety", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/project");
    await page.evaluate(async () => {
      localStorage.clear();
      // Wipe any prior IndexedDB so each test starts clean.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyIdb = indexedDB as any;
      if (anyIdb.databases) {
        const dbs = await anyIdb.databases();
        for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
      } else {
        indexedDB.deleteDatabase("AirSpiceDB");
      }
    });
    await page.reload();
  });

  test("recovers a mid-edit change after a hard reload (debounced autosave)", async ({ page }) => {
    await createBlankProject(page);
    const marker = `CRASH_DEBOUNCE_${Date.now()}`;
    await typeMarkerIntoEditor(page, marker);

    // Wait past the ~1s debounce so the autosave lands.
    await page.waitForTimeout(1500);

    // Hard reload — brand-new page, same IndexedDB.
    await page.reload();

    await expect
      .poll(async () => {
        const records = await readAllProjects(page);
        return records.some((r) => r.xml.includes(marker));
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test("flushes immediately on pagehide (before the debounce could fire)", async ({ page }) => {
    await createBlankProject(page);
    const marker = `CRASH_PAGEHIDE_${Date.now()}`;
    await typeMarkerIntoEditor(page, marker);

    // Fire pagehide right away — the flush must persist WITHOUT waiting 1s.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

    await expect
      .poll(async () => {
        const records = await readAllProjects(page);
        return records.some((r) => r.xml.includes(marker));
      }, { timeout: 5_000 })
      .toBe(true);

    // And it genuinely survives a reload.
    await page.reload();
    const after = await readAllProjects(page);
    expect(after.some((r) => r.xml.includes(marker))).toBe(true);
  });
});
