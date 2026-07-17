import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/harness/index.html");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => (window as any).__storage !== undefined);

  // Initialize and clear projects store
  await page.evaluate(async () => {
    const store = window.__storage.useProjectStore.getState();
    
    // Close any previous connection
    if (store.db) {
      store.db.close();
      store.db = null;
    }

    const { db } = await window.__storage.initDatabase();
    store.db = db;
    
    // Reset store state
    window.__storage.useProjectStore.setState({
      projectsList: [],
      activeProjectId: null,
      conflictError: null,
      initialized: true,
      storageError: null,
    });

    if (db) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        const os = tx.objectStore("projects");
        os.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  });
});

test("create -> edit -> autosave -> verify project intact", async ({ page }) => {
  // 1. Initialize
  await page.evaluate(() => window.__storage.useProjectStore.getState().init());

  // 2. Create project
  const id = await page.evaluate(() => {
    return window.__storage.useProjectStore.getState().createProject("Autosave Test", "<system name='test'/>");
  });
  expect(id).toBeDefined();

  // 3. Verify created project in database
  let project = await page.evaluate((projId) => window.__storage.getProject(projId), id);
  expect(project).not.toBeNull();
  expect(project.name).toBe("Autosave Test");
  expect(project.xml).toBe("<system name='test'/>");

  // 4. Edit project XML & trigger autosave
  const updatedXml = "<system name='edited_xml'/>";
  await page.evaluate(({ xml }) => {
    window.__storage.useDesignStore.getState().setUserXml(xml);
    return window.__storage.useProjectStore.getState().saveActiveProjectXml(xml);
  }, { xml: updatedXml });

  // 5. Verify the updated XML is persisted to IndexedDB
  project = await page.evaluate((projId) => window.__storage.getProject(projId), id);
  expect(project.xml).toBe(updatedXml);
});

test("concurrent cold-start initialization shares one database open", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const [first, second] = await Promise.all([
      window.__storage.initDatabase(),
      window.__storage.initDatabase(),
    ]);
    return {
      bothReady: first.db !== null && second.db !== null,
      sameConnection: first.db === second.db,
      firstError: first.error,
      secondError: second.error,
    };
  });

  expect(result).toEqual({
    bothReady: true,
    sameConnection: true,
    firstError: null,
    secondError: null,
  });
});

test("two tabs editing: conflict detected", async ({ page }) => {
  await page.evaluate(() => window.__storage.useProjectStore.getState().init());

  const id = await page.evaluate(() => {
    return window.__storage.useProjectStore.getState().createProject("Conflict Test", "<system/>");
  });

  // Tab A (current page) has loaded the project.
  // Tab B edits and saves the project directly in IndexedDB, updating the updatedAt timestamp
  await page.evaluate(async (projId) => {
    const record = await window.__storage.getProject(projId);
    if (record) {
      record.xml = "<system name='tab_b'/>";
      record.updatedAt = Date.now() + 5000; // Future timestamp
      await window.__storage.saveProject(record);
    }
  }, id);

  // Tab A tries to save a different edit
  await page.evaluate(async () => {
    await window.__storage.useProjectStore.getState().saveActiveProjectXml("<system name='tab_a'/>");
  });

  // Verify that Tab A detected the conflict and set conflictError
  const conflictError = await page.evaluate(() => {
    return window.__storage.useProjectStore.getState().conflictError;
  });
  expect(conflictError).toContain("Conflict detected");

  // Verify Tab A did NOT overwrite Tab B's save
  const record = await page.evaluate((projId) => window.__storage.getProject(projId), id);
  expect(record.xml).toBe("<system name='tab_b'/>");
});

test("delete project is undoable for 10s", async ({ page }) => {
  await page.evaluate(() => window.__storage.useProjectStore.getState().init());

  const id = await page.evaluate(() => {
    return window.__storage.useProjectStore.getState().createProject("Delete Test", "<system/>");
  });

  // Delete project
  await page.evaluate((projId) => {
    return window.__storage.useProjectStore.getState().deleteProjectWithUndo(projId);
  }, id);

  // Verify project is deleted from list
  let list = await page.evaluate(() => window.__storage.useProjectStore.getState().projectsList);
  expect(list.find((p) => p.id === id)).toBeUndefined();

  // Restore project
  await page.evaluate(() => {
    return window.__storage.useProjectStore.getState().restoreDeletedProject();
  });

  // Verify project is restored
  list = await page.evaluate(() => window.__storage.useProjectStore.getState().projectsList);
  expect(list.find((p) => p.id === id)).toBeDefined();
  const restored = list.find((p) => p.id === id);
  expect(restored?.name).toBe("Delete Test");
});

test("import xml: security gate rejects hostile payload", async ({ page }) => {
  await page.evaluate(() => window.__storage.useProjectStore.getState().init());

  // Try importing a billion-laughs hostile entity payload (SEC-001)
  const hostileXml = `<?xml version="1.0"?>
  <!DOCTYPE lolz [
    <!ENTITY lol "lol">
    <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  ]>
  <system name="hostile"/>`;

  const parseFailed = await page.evaluate((xmlText) => {
    const bytes = new TextEncoder().encode(xmlText);
    try {
      window.__storage.parseXmlBytes(bytes);
      return false;
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (e as any).code === "SEC-001";
    }
  }, hostileXml);

  expect(parseFailed).toBe(true);
});
