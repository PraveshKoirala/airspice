export interface ProjectRecord {
  id: string;
  name: string;
  xml: string;
  createdAt: number;
  updatedAt: number;
  thumbnailSvg?: string;
  fileHandle?: FileSystemFileHandle;
  /**
   * The integer schema version the record was last written under (backfilled by
   * the v2 migration, stamped by every subsequent write). It carries per-record
   * provenance so a future migration can branch on the shape a record was
   * created with, independent of the whole-database version. Optional so a
   * pre-v2 (unmigrated) record is still a valid `ProjectRecord`.
   */
  schemaVersion?: number;
}

export interface Migration {
  version: number;
  run: (db: IDBDatabase, transaction: IDBTransaction) => void;
}

/**
 * The database's integer schema version. Bumping this REQUIRES appending a
 * matching `Migration` below; `openDbWithVersion` replays every migration whose
 * `version` is newer than the on-disk version, in order, inside the single
 * `versionchange` transaction. Never mutate the schema without bumping this and
 * registering the migration (post-audit amendment, PRD #26 criterion 2).
 */
export const CURRENT_VERSION = 2;
export const DB_NAME = "AirSpiceDB";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    // v1: the original single object store keyed by the project id.
    run: (db) => {
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
    },
  },
  {
    version: 2,
    // v2: stamp an explicit integer `schemaVersion` onto every stored record.
    // This is a genuine forward migration (not a no-op): it REWRITES every
    // existing record in place via a cursor, inside the versionchange
    // transaction, preserving all other fields — crucially the design `xml` —
    // byte-for-byte. A record already at v2 is left untouched (idempotent).
    run: (_db, transaction) => {
      const store = transaction.objectStore("projects");
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const record = cursor.value as ProjectRecord;
        if (record.schemaVersion !== 2) {
          cursor.update({ ...record, schemaVersion: 2 });
        }
        cursor.continue();
      };
    },
  },
];

export function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

let activeDb: IDBDatabase | null = null;
let initialization: Promise<DatabaseInitResult> | null = null;

export interface DatabaseInitResult {
  db: IDBDatabase | null;
  isDowngraded: boolean;
  diskVersion: number;
  error: string | null;
}

/**
 * Open the database at whatever version exists on disk (without specifying one)
 * so we can check the version safely without triggering VersionError.
 */
function openDbWithoutVersion(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Delete the database, resolving even if the delete is momentarily blocked by
 * another open connection (we do not throw on `onblocked`; the delete completes
 * once the blocker closes, firing `onsuccess`).
 */
function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Open the database with a specific version, running migrations sequentially
 * during upgradeneeded.
 */
function openDbWithVersion(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) return;
      const oldVersion = event.oldVersion;

      // Replay every registered migration newer than the on-disk version, in
      // ascending order, inside this single versionchange transaction.
      for (const m of MIGRATIONS) {
        if (m.version > oldVersion && m.version <= version) {
          m.run(db, transaction);
        }
      }
    };
    // A concurrent open connection (e.g. another tab) blocks the upgrade. We
    // surface it as an error rather than hanging forever; the caller reports it
    // through the storage-error path instead of leaving the app on a spinner.
    request.onblocked = () =>
      reject(
        new Error(
          "Database upgrade is blocked by another open tab. Close other AirSpice tabs and reload.",
        ),
      );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Initialize the database connection, handling schema version checks and migrations.
 */
async function initializeDatabase(): Promise<DatabaseInitResult> {
  try {
    // Close any connection a prior init left open so it cannot block the
    // version upgrade below (its own open handle would otherwise `onblocked`
    // the deleteDatabase / version bump). Harmless on a genuine cold start.
    if (activeDb) {
      activeDb.close();
      activeDb = null;
    }

    const dbCheck = await openDbWithoutVersion();
    const diskVersion = dbCheck.version;
    const hasProjects = dbCheck.objectStoreNames.contains("projects");
    dbCheck.close();

    if (diskVersion > CURRENT_VERSION) {
      // Downgrade scenario: Disk version is newer than code version.
      // Leave connection open in check mode so refusal UI can query raw records.
      const db = await openDbWithoutVersion();
      activeDb = db;
      return { db, isDowngraded: true, diskVersion, error: null };
    }

    if (diskVersion === 1 && !hasProjects) {
      // Newly created database by openDbWithoutVersion or empty database.
      // Delete it and reopen to force upgrade sequence.
      await deleteDb();
    }

    // Normal scenario or upgrade: Open with target code version.
    const db = await openDbWithVersion(CURRENT_VERSION);
    activeDb = db;
    return { db, isDowngraded: false, diskVersion, error: null };
  } catch (error) {
    console.error("Failed to initialize IndexedDB:", error);
    activeDb = null;
    return {
      db: null,
      isDowngraded: false,
      diskVersion: 0,
      error: `Local project storage is unavailable: ${(error as Error).message}`,
    };
  }
}

/**
 * Initialize the database once per concurrent cold start. React Strict Mode
 * intentionally runs mount effects twice in development; sharing this promise
 * prevents two upgrade/delete sequences from blocking each other.
 */
export async function initDatabase(): Promise<DatabaseInitResult> {
  if (initialization) return initialization;
  initialization = initializeDatabase();
  try {
    return await initialization;
  } finally {
    initialization = null;
  }
}

/**
 * Get a database connection helper, ensuring DB is initialized.
 */
function getDb(): IDBDatabase {
  if (!activeDb) {
    throw new Error("Database not initialized");
  }
  return activeDb;
}

/**
 * Close the active connection (if any) and drop the cached handle. Releases the
 * IndexedDB lock so a subsequent version upgrade — from another tab, or a fresh
 * `initDatabase()` after schema changes — is not blocked by this tab's open
 * handle. Safe to call when nothing is open.
 */
export function closeDatabase(): void {
  if (activeDb) {
    activeDb.close();
    activeDb = null;
  }
}

/**
 * Retrieve a project record by ID.
 */
export function getProject(id: string): Promise<ProjectRecord | null> {
  return new Promise((resolve, reject) => {
    try {
      const db = getDb();
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Save or update a project record.
 */
export function saveProject(project: ProjectRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const db = getDb();
      const transaction = db.transaction("projects", "readwrite");
      const store = transaction.objectStore("projects");
      // Stamp the current schema version on every write so records minted after
      // the v2 migration carry the same provenance marker the migration
      // backfilled onto pre-existing records (keeps the whole store uniform).
      const request = store.put({ ...project, schemaVersion: CURRENT_VERSION });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * List all project records.
 */
export function listProjects(): Promise<ProjectRecord[]> {
  return new Promise((resolve, reject) => {
    try {
      const db = getDb();
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Delete a project record by ID.
 */
export function deleteProject(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const db = getDb();
      const transaction = db.transaction("projects", "readwrite");
      const store = transaction.objectStore("projects");
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Export all raw records from a given database connection (used for downgrade screen).
 */
export function exportAllRawRecords(db: IDBDatabase): Promise<ProjectRecord[]> {
  return new Promise((resolve, reject) => {
    try {
      if (!db.objectStoreNames.contains("projects")) {
        resolve([]);
        return;
      }
      const transaction = db.transaction("projects", "readonly");
      const store = transaction.objectStore("projects");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    } catch (e) {
      reject(e);
    }
  });
}
