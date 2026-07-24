/**
 * AC#6 — Importing malformed/malicious XML shows a diagnostic and leaves the
 * currently-open project untouched (Playwright / real Chromium).
 *
 * The import runs through the app's real Import menu -> `openFromDisk` -> the
 * air-ts security gate. A DOCTYPE/XXE file must be rejected: a diagnostic is
 * surfaced and NO project is created or destroyed.
 *
 * MECHANISM NOTE: Playwright's Chromium (secure context on 127.0.0.1) exposes
 * the native File System Access API, which Playwright cannot drive. We DISABLE
 * FSA before the app loads (`disableFsa`) so "Import XML File..." feature-detects
 * false and uses the <input type=file> fallback — the path Playwright drives via
 * `filechooser` + `setFiles`. Both `openFromDisk` branches route imported bytes
 * through the SAME `parseXmlBytes` gate; the gate itself is also unit-tested on
 * both branches in `import_security_gate.test.ts`.
 */

import { test, expect, type Page } from "@playwright/test";

const MALICIOUS_XML =
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE system [<!ENTITY xxe "boom">]>\n<system name="evil">&xxe;</system>`;

/** Force the app onto the <input type=file> fallback by removing FSA globals. */
async function disableFsa(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ["showOpenFilePicker", "showSaveFilePicker"]) {
      // `isFileSystemAccessSupported()` tests `name in window`, so the property
      // must be REMOVED (undefined would still satisfy `in`). WebIDL exposes
      // these on Window.prototype, so walk the chain and delete every own copy.
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

async function seed(page: Page): Promise<void> {
  await page.goto("/tests/browser/harness/index.html");
  await page.waitForFunction(() => (window as any).__storage !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
    indexedDB.deleteDatabase("AirSpiceDB");
  });
  await page.reload();
  await page.waitForFunction(() => (window as any).__storage !== undefined);
  await page.evaluate(async () => {
    const s = (window as any).__storage.useProjectStore;
    await s.getState().init();
    await s.getState().createProject("KeepOpen", "<system name='keep_me_open'/>");
  });
}

async function projectCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open("AirSpiceDB");
        req.onsuccess = () => {
          const db = req.result;
          const c = db.transaction("projects", "readonly").objectStore("projects").count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => reject(c.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

test("AC#6 malformed import shows a diagnostic and does not destroy the open project", async ({ page }) => {
  await disableFsa(page);
  await seed(page);
  await page.goto("/project");
  await expect(page.locator(".project-list-item:has-text('KeepOpen')").first()).toBeVisible();

  // Guard: the app must be on the driveable <input> fallback path.
  expect(await page.evaluate(() => "showOpenFilePicker" in window)).toBe(false);

  const before = await projectCount(page);
  expect(before).toBe(1);

  // Capture the import-failure diagnostic (Sidebar surfaces it via a dialog).
  let dialogMsg = "";
  page.on("dialog", async (d) => {
    dialogMsg = d.message();
    await d.dismiss();
  });

  // Drive the real Import menu with a malicious file.
  await page.locator(".sidebar-create-btn").click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByText("Import XML File...").click(),
  ]);
  await chooser.setFiles({
    name: "evil.xml",
    mimeType: "text/xml",
    buffer: Buffer.from(MALICIOUS_XML, "utf-8"),
  });

  // A diagnostic is shown...
  await expect.poll(() => dialogMsg, { timeout: 10_000 }).toContain("Import failed");

  // ...and the open project is untouched: no new project, KeepOpen still there.
  await expect(page.locator(".project-list-item:has-text('KeepOpen')").first()).toBeVisible();
  expect(await projectCount(page)).toBe(1);
  const all = await page.evaluate(
    () =>
      new Promise<any[]>((resolve, reject) => {
        const req = indexedDB.open("AirSpiceDB");
        req.onsuccess = () => {
          const g = req.result
            .transaction("projects", "readonly")
            .objectStore("projects")
            .getAll();
          g.onsuccess = () => resolve(g.result);
          g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect(all.every((r) => !r.xml.includes("<!DOCTYPE"))).toBe(true);
});
