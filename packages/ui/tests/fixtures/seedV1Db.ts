/**
 * Test fixture helper (PRD #26 criterion 2) — NOT a test file.
 *
 * Seeds a genuine v(N-1)=v1 AirSpice IndexedDB into whatever `indexedDB` global
 * is present (the fake-indexeddb shim under vitest, or a real browser DB under
 * Playwright). A v1 database is exactly: database version 1, one object store
 * `projects` keyed by `id`, NO indexes, and records WITHOUT a `schemaVersion`
 * field — the shape that shipped before the v2 migration existed.
 *
 * A migration test calls `seedV1Database()` first, then opens the database with
 * the CURRENT (v2) production code (`initDatabase()` from src/storage/db.ts) and
 * asserts every project's `xml` survived the v1->v2 migration byte-for-byte
 * while gaining `schemaVersion === 2`. The exact records seeded are exported as
 * `V1_FIXTURE_PROJECTS` so the test can compare against them.
 */
import fixture from "./db-v1.json" with { type: "json" };

export interface V1ProjectRecord {
  id: string;
  name: string;
  xml: string;
  createdAt: number;
  updatedAt: number;
  thumbnailSvg?: string;
}

const DB_NAME: string = fixture.dbName;
const STORE_NAME: string = fixture.storeName;
const KEY_PATH: string = fixture.keyPath;
const V1_VERSION: number = fixture.version;

/** The exact project records the v1 fixture database is seeded with. */
export const V1_FIXTURE_PROJECTS: V1ProjectRecord[] = fixture.projects as V1ProjectRecord[];

/** The database name the fixture (and production code) uses. */
export const V1_DB_NAME = DB_NAME;

/**
 * Delete any existing database of this name, then create it fresh at schema
 * version 1 with the original single `projects` store and the fixture records.
 * Resolves once the records are committed and the connection is closed, leaving
 * a clean v1 database on disk for the production code to open and migrate.
 */
export function seedV1Database(): Promise<void> {
  return new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onerror = () => reject(del.error);
    del.onblocked = () =>
      reject(new Error("seedV1Database: deleteDatabase blocked by an open connection"));
    del.onsuccess = () => {
      const open = indexedDB.open(DB_NAME, V1_VERSION);
      open.onerror = () => reject(open.error);
      open.onupgradeneeded = () => {
        const db = open.result;
        // The v1 schema: a single store keyed by id, with NO indexes.
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: KEY_PATH });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const record of V1_FIXTURE_PROJECTS) {
          // Written exactly as v1 shipped: no schemaVersion field.
          store.put(record);
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("seedV1Database: transaction aborted"));
      };
    };
  });
}
