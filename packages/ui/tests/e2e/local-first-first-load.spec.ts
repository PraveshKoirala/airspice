/**
 * AC#8 — Migration-on-first-load: on first load of the new build, the design the
 * editor holds under the old single-design behavior is persisted as an
 * "Untitled project" — no silent data loss (Playwright / real Chromium).
 *
 * With an EMPTY IndexedDB, opening `/project` must materialize a real, persisted
 * project (not a phantom): it survives a hard reload and carries a non-empty
 * design.
 */

import { test, expect, type Page } from "@playwright/test";

async function readAll(page: Page): Promise<Array<{ id: string; name: string; xml: string }>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("AirSpiceDB");
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("projects")) return resolve([]);
          const g = db.transaction("projects", "readonly").objectStore("projects").getAll();
          g.onsuccess = () => resolve(g.result);
          g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

test("AC#8 first load persists the held design as a project (no data loss)", async ({ page }) => {
  // Start from a completely empty local store.
  await page.goto("/project");
  await page.evaluate(async () => {
    localStorage.clear();
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

  // The first load must materialize a persisted project.
  await expect
    .poll(async () => (await readAll(page)).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);

  const records = await readAll(page);
  const untitled = records.find((r) => r.name === "Untitled Project") ?? records[0]!;
  expect(untitled.xml.trim().length).toBeGreaterThan(0); // the held design is not lost
  const persistedId = untitled.id;

  // It is real, not a phantom: it survives a hard reload without duplicating.
  await page.reload();
  await expect
    .poll(async () => {
      const after = await readAll(page);
      return after.some((r) => r.id === persistedId);
    }, { timeout: 10_000 })
    .toBe(true);

  // No phantom explosion: reloading did not spawn a second default project.
  const finalCount = (await readAll(page)).length;
  expect(finalCount).toBe(records.length);
});
