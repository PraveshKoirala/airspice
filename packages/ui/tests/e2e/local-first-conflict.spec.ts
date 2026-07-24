/**
 * AC#4 — Two contexts editing one project: conflict surfaced, no silent clobber
 * (Playwright / real Chromium, real IndexedDB).
 *
 * "A stale writer (whose base `updatedAt` is older than the stored record's
 *  `updatedAt`) does not silently clobber a newer save; the conflict is surfaced
 *  (toast) rather than lost."
 *
 * Two pages in ONE browser context share the same IndexedDB (two tabs). Test 1
 * drives the real project store deterministically through the harness (real
 * write-guard, real DB). Test 2 reproduces it through the real `/project` UI and
 * asserts the on-screen conflict banner on the stale tab.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";

const DB_NAME = "AirSpiceDB";

async function wipe(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto("/tests/browser/harness/index.html");
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("AirSpiceDB");
  });
  await page.close();
}

async function readXml(page: Page, id: string): Promise<string | null> {
  return page.evaluate(
    ({ dbName, pid }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("projects")) return resolve(null);
          const g = db.transaction("projects", "readonly").objectStore("projects").get(pid);
          g.onsuccess = () => resolve(g.result ? g.result.xml : null);
          g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { dbName: DB_NAME, pid: id },
  );
}

test.describe("AC#4 two-tab conflict", () => {
  test("stale writer is blocked and surfaces a conflict (store-level, deterministic)", async ({ context }) => {
    await wipe(context);

    const tabA = await context.newPage();
    const tabB = await context.newPage();
    for (const p of [tabA, tabB]) {
      await p.goto("/tests/browser/harness/index.html");
      await p.waitForFunction(() => (window as any).__storage !== undefined);
      await p.evaluate(() => (window as any).__storage.useProjectStore.getState().init());
    }

    // Tab A creates and selects the shared project.
    const id = await tabA.evaluate(() =>
      (window as any).__storage.useProjectStore.getState().createProject("Shared", "<system name='v0'/>"),
    );

    // Tab B loads + selects it (captures the SAME base updatedAt).
    await tabB.evaluate(async (pid) => {
      const s = (window as any).__storage.useProjectStore;
      await s.getState().loadProjects();
      await s.getState().selectProject(pid);
    }, id);

    // Tab A saves a newer version (strictly-later timestamp).
    await tabA.waitForTimeout(25);
    await tabA.evaluate(() =>
      (window as any).__storage.useProjectStore.getState().saveActiveProjectXml("<system name='A_wins'/>"),
    );
    expect(await readXml(tabA, id)).toBe("<system name='A_wins'/>");

    // Tab B (stale) tries to save -> must be blocked + surface a conflict.
    await tabB.evaluate(() =>
      (window as any).__storage.useProjectStore.getState().saveActiveProjectXml("<system name='B_stale'/>"),
    );
    const conflict = await tabB.evaluate(
      () => (window as any).__storage.useProjectStore.getState().conflictError,
    );
    expect(conflict).toBeTruthy();

    // No silent clobber: A's version is still on disk.
    expect(await readXml(tabB, id)).toBe("<system name='A_wins'/>");
  });

  test("surfaces the conflict banner in the real UI on the stale tab", async ({ context }) => {
    await wipe(context);

    // Seed one project through the harness so both /project tabs open the same one.
    const seed = await context.newPage();
    await seed.goto("/tests/browser/harness/index.html");
    await seed.waitForFunction(() => (window as any).__storage !== undefined);
    const id = await seed.evaluate(async () => {
      const s = (window as any).__storage.useProjectStore;
      await s.getState().init();
      return s.getState().createProject("Shared UI", "<system name='v0'/>");
    });
    await seed.close();

    const tabA = await context.newPage();
    const tabB = await context.newPage();
    await tabA.goto("/project");
    await tabB.goto("/project"); // both load + select the same project (stale base captured)
    await expect(tabA.locator(".project-list-item:has-text('Shared UI')").first()).toBeVisible();
    await expect(tabB.locator(".project-list-item:has-text('Shared UI')").first()).toBeVisible();

    // Tab A writes a newer version directly to storage (simulating its autosave).
    await tabA.evaluate(async (pid) => {
      const st = (window as any); // /project does not expose stores; go via raw IDB
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("AirSpiceDB");
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("projects", "readwrite");
          const store = tx.objectStore("projects");
          const g = store.get(pid);
          g.onsuccess = () => {
            const rec = g.result;
            rec.xml = "<system name='A_wins_ui'/>";
            rec.updatedAt = Date.now() + 10_000; // strictly newer than tab B's base
            store.put(rec);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      void st;
    }, id);

    // Tab B (stale) edits + autosaves through the real app -> guard fires -> banner.
    await tabB.locator(".sidebar-tab").filter({ hasText: /^AIR XML$/ }).click();
    const editor = tabB.locator(".monaco-editor").first();
    await editor.click();
    await tabB.keyboard.press("Control+Home");
    await tabB.keyboard.type("<!--B_STALE_EDIT-->\n");
    await tabB.waitForTimeout(1500); // let the debounce fire the guarded save

    await expect(tabB.locator(".conflict-banner")).toBeVisible();
    // A's newer content is intact (no clobber).
    expect(await readXml(tabB, id)).toBe("<system name='A_wins_ui'/>");
  });
});
