/**
 * AC#3 — No-downgrade escape hatch.
 *
 * Contract (PRD #26 criterion 3): "A newer-schema DB opened by older code
 * refuses cleanly and offers an 'export projects' path that reads raw records
 * without the newer schema's logic."
 *
 * Real entry points: `initDatabase()` (its `isDowngraded` / `diskVersion` /
 * `error` result) and `exportAllRawRecords(db)` from `src/storage/db.ts`.
 *
 * Genuine failure modes this catches:
 *   - A version-blind open would try to migrate the future DB *down* (VersionError)
 *     or silently open it as if current -> `isDowngraded` stays false -> FAILS.
 *   - Refusing by throwing (error set, db null) instead of offering raw export
 *     -> the `exportAllRawRecords` assertion FAILS.
 *   - A "raw export" that actually runs the current schema's read/normalize logic
 *     would not survive a genuinely-newer store shape; we assert it returns the
 *     raw records verbatim (byte-equal XML).
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, it, expect, vi } from "vitest";

function openRaw(
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("openRaw blocked"));
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("AC#3 no-downgrade refusal + raw export", () => {
  it("refuses cleanly and exposes raw records when the disk schema is newer", async () => {
    const { CURRENT_VERSION, DB_NAME, initDatabase, exportAllRawRecords } =
      await import("../../src/storage/db");

    const futureVersion = CURRENT_VERSION + 1;
    const FUTURE_XML = "<system name='from_the_future'>\n  <!-- v" +
      futureVersion + " payload -->\n</system>\n";
    const record = {
      id: "future-1",
      name: "Future Project",
      xml: FUTURE_XML,
      createdAt: 2_000_000_000_000,
      updatedAt: 2_000_000_000_000,
    };

    // A database written by a NEWER build of the app.
    const futureDb = await openRaw(DB_NAME, futureVersion, (db) => {
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
    });
    await put(futureDb, "projects", record);
    futureDb.close();

    // Older code opens it: must refuse (not migrate down, not throw).
    const result = await initDatabase();
    expect(result.isDowngraded).toBe(true);
    expect(result.diskVersion).toBe(futureVersion);
    expect(result.error).toBeNull();
    expect(result.db).not.toBeNull();

    // The escape hatch: raw export reads the records without current-schema logic.
    const raw = await exportAllRawRecords(result.db!);
    expect(raw.length).toBe(1);
    expect(raw[0]!.id).toBe("future-1");
    expect(raw[0]!.xml).toBe(FUTURE_XML);
  });

  it("does not clobber or downgrade the on-disk version", async () => {
    const { CURRENT_VERSION, DB_NAME, initDatabase } = await import(
      "../../src/storage/db"
    );
    const futureVersion = CURRENT_VERSION + 1;

    const futureDb = await openRaw(DB_NAME, futureVersion, (db) => {
      db.createObjectStore("projects", { keyPath: "id" });
    });
    futureDb.close();

    await initDatabase();

    // Re-open raw and confirm the version was left untouched (no destructive
    // downgrade of the user's newer database).
    const check = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(check.version).toBe(futureVersion);
    check.close();
  });
});
