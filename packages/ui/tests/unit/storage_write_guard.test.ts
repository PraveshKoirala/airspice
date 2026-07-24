/**
 * AC#4 — Monotonic write-guard / conflict (no silent clobber).
 *
 * Contract (PRD #26 criterion 4): "A stale writer (whose base `updatedAt` is
 * older than the stored record's `updatedAt`) does not silently clobber a newer
 * save; the conflict is surfaced (toast) rather than lost. Last-write-wins is
 * gated on the `updatedAt` check."
 *
 * Real entry points: the `useProjectStore` actions `init` / `createProject` /
 * `selectProject` / `saveActiveProjectXml` and its `conflictError` field, plus
 * the raw `getProject` to inspect what actually landed on disk.
 *
 * Genuine failure modes this catches:
 *   - Unconditional `store.put` (last-write-wins with no guard): the stale write
 *     overwrites the newer tab's XML AND no conflict is surfaced -> both
 *     assertions FAIL.
 *   - A guard that always blocks (never lets a legitimate save through): the
 *     "fresh save succeeds" test FAILS.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, it, expect, vi } from "vitest";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("AC#4 monotonic write-guard", () => {
  it("rejects a STALE write, surfaces a conflict, and does not clobber the newer record", async () => {
    const { useProjectStore } = await import("../../src/storage/projectStore");
    const { getProject, saveProject } = await import("../../src/storage/db");

    await useProjectStore.getState().init();
    const id = await useProjectStore
      .getState()
      .createProject("Shared", "<system name='v0'/>");

    // The open tab loaded this record; remember the base it saw.
    const baseUpdatedAt = useProjectStore.getState().localLoadedUpdatedAt;
    expect(useProjectStore.getState().activeProjectId).toBe(id);

    // --- Another tab writes a NEWER version straight to storage. ---
    const onDisk = await getProject(id);
    expect(onDisk).not.toBeNull();
    const NEWER_XML = "<system name='written_by_other_tab'/>";
    await saveProject({
      ...onDisk!,
      xml: NEWER_XML,
      updatedAt: baseUpdatedAt + 5000, // strictly newer than the stale writer's base
    });

    // --- The stale tab (still holding the old base) tries to autosave. ---
    const STALE_XML = "<system name='stale_edit_should_not_win'/>";
    await useProjectStore.getState().saveActiveProjectXml(STALE_XML);

    // The conflict must be SURFACED, not swallowed.
    const conflict = useProjectStore.getState().conflictError;
    expect(conflict).toBeTruthy();
    expect(typeof conflict).toBe("string");

    // The newer record must be intact — the stale write did NOT clobber it.
    const after = await getProject(id);
    expect(after!.xml).toBe(NEWER_XML);
    expect(after!.xml).not.toBe(STALE_XML);
  });

  it("permits a legitimate up-to-date save (guard is not a blanket block)", async () => {
    const { useProjectStore } = await import("../../src/storage/projectStore");
    const { getProject } = await import("../../src/storage/db");

    await useProjectStore.getState().init();
    const id = await useProjectStore
      .getState()
      .createProject("Solo", "<system name='v0'/>");

    const FRESH_XML = "<system name='legit_next_edit'/>";
    await useProjectStore.getState().saveActiveProjectXml(FRESH_XML);

    expect(useProjectStore.getState().conflictError).toBeFalsy();
    const after = await getProject(id);
    expect(after!.xml).toBe(FRESH_XML);
  });
});
