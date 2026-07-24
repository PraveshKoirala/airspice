/**
 * AC#7 — Delete is undoable; after undo the project is fully restored
 * (including thumbnail). No instant destructive delete.
 *
 * Real entry points: `useProjectStore` actions `deleteProjectWithUndo` /
 * `restoreDeletedProject` and the `deletedProjectBackup` field, with raw
 * `getProject` to confirm what is actually on disk.
 *
 * Genuine failure modes this catches:
 *   - A plain destructive delete (no backup): `deletedProjectBackup` stays null
 *     and the record cannot be brought back -> FAILS.
 *   - A restore that loses the thumbnail or mangles XML -> byte-equality FAILS.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, it, expect, vi } from "vitest";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("AC#7 delete -> undo restores fully", () => {
  it("backs up on delete and fully restores (XML + thumbnail) on undo", async () => {
    const { useProjectStore } = await import("../../src/storage/projectStore");
    const { getProject, saveProject } = await import("../../src/storage/db");

    await useProjectStore.getState().init();
    const XML = "<system name='to_be_deleted'>\n  <nets/>\n</system>\n";
    const id = await useProjectStore.getState().createProject("Deletable", XML);

    // Give it a thumbnail so we can prove restore is *complete*, not partial.
    const base = await getProject(id);
    const THUMB = "<svg viewBox='0 0 10 10'><rect/></svg>";
    await saveProject({ ...base!, thumbnailSvg: THUMB });
    await useProjectStore.getState().loadProjects();

    const before = await getProject(id);
    expect(before!.thumbnailSvg).toBe(THUMB);

    // --- Delete (undoable) ---
    await useProjectStore.getState().deleteProjectWithUndo(id);

    // A backup exists (no instant destructive delete)...
    const backup = useProjectStore.getState().deletedProjectBackup;
    expect(backup).not.toBeNull();
    expect(backup!.id).toBe(id);
    expect(backup!.thumbnailSvg).toBe(THUMB);
    // ...and the live record is gone.
    expect(await getProject(id)).toBeNull();
    expect(
      useProjectStore.getState().projectsList.some((p) => p.id === id),
    ).toBe(false);

    // --- Undo ---
    await useProjectStore.getState().restoreDeletedProject();

    const restored = await getProject(id);
    expect(restored).not.toBeNull();
    expect(restored!.xml).toBe(XML); // byte-equal
    expect(restored!.thumbnailSvg).toBe(THUMB); // thumbnail preserved
    expect(restored!.name).toBe("Deletable");
    expect(useProjectStore.getState().deletedProjectBackup).toBeNull();
    expect(
      useProjectStore.getState().projectsList.some((p) => p.id === id),
    ).toBe(true);
  });
});
