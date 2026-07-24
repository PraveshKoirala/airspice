/**
 * AC#1 (unit portion) — Autosave durability + crash recovery.
 *
 * Contract (PRD #26 criterion 1): "Edits autosave to IndexedDB ... A mid-edit
 * hard reload recovers the last autosaved state (no lost work)."
 *
 * SPLIT OF CONCERNS (deliberate, so tests target real entry points):
 *   - The DEBOUNCE timer and the `visibilitychange`->hidden / `pagehide` FLUSH
 *     listeners live in the React `ProjectWorkspace` component (App.tsx), not in
 *     the storage layer. Those are exercised end-to-end in the Playwright spec
 *     `tests/e2e/local-first-crash-safety.spec.ts` (edit -> dispatch
 *     visibilitychange/pagehide -> hard reload -> project intact), which is the
 *     only place the wiring genuinely exists.
 *   - THIS unit test targets the storage-layer guarantee the flush/debounce rely
 *     on: once an autosave lands via `saveActiveProjectXml`, the exact bytes are
 *     durable and recover on a fresh cold start (a simulated reload = new JS
 *     module realm, same IndexedDB). No lost work.
 *
 * Genuine failure modes this catches:
 *   - An in-memory-only "save" (never written to IndexedDB) does not survive the
 *     cold start -> recovery FAILS.
 *   - A save that persists a stale/intermediate value rather than the latest edit
 *     -> last-write assertion FAILS.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, it, expect, vi } from "vitest";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("AC#1 autosave durability + crash recovery", () => {
  it("recovers the last autosaved XML after a simulated hard reload", async () => {
    // --- Session 1: create + edit + autosave ---
    let mod = await import("../../src/storage/projectStore");
    await mod.useProjectStore.getState().init();
    const id = await mod
      .useProjectStore.getState()
      .createProject("Recoverable", "<system name='v0'/>");

    const LATEST = "<system name='mid_edit_state'>\n  <nets/>\n</system>\n";
    await mod.useProjectStore.getState().saveActiveProjectXml(LATEST);

    // --- Simulate a hard reload: brand-new JS realm (module singletons reset,
    //     db `activeDb` cleared), but the SAME IndexedDB survives. ---
    vi.resetModules();
    mod = await import("../../src/storage/projectStore");
    const db = await import("../../src/storage/db");

    await mod.useProjectStore.getState().init();
    // The record is still there, byte-for-byte.
    const recovered = await db.getProject(id);
    expect(recovered).not.toBeNull();
    expect(recovered!.xml).toBe(LATEST);

    // And selecting it re-hydrates the editor's design store with that XML.
    const design = await import("../../src/agent/designStore");
    await mod.useProjectStore.getState().selectProject(id);
    expect(design.useDesignStore.getState().xml).toBe(LATEST);
  });

  it("persists the latest edit when several autosaves fire in quick succession", async () => {
    const { useProjectStore } = await import("../../src/storage/projectStore");
    const { getProject } = await import("../../src/storage/db");

    await useProjectStore.getState().init();
    const id = await useProjectStore
      .getState()
      .createProject("Rapid", "<system name='v0'/>");

    // Rapid edits (what the debounce coalesces): the LAST one must win on disk.
    await useProjectStore.getState().saveActiveProjectXml("<system name='a'/>");
    await useProjectStore.getState().saveActiveProjectXml("<system name='b'/>");
    await useProjectStore.getState().saveActiveProjectXml("<system name='c'/>");

    const after = await getProject(id);
    expect(after!.xml).toBe("<system name='c'/>");
    expect(useProjectStore.getState().conflictError).toBeFalsy();
  });
});
