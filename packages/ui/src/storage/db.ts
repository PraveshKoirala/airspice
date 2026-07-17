export interface ProjectRecord {
  id: string;
  name: string;
  xml: string;
  createdAt: number;
  updatedAt: number;
  thumbnailSvg?: string;
  fileHandle?: FileSystemFileHandle;
}

export interface Migration {
  version: number;
  run: (db: IDBDatabase, transaction: IDBTransaction) => void;
}

export const CURRENT_VERSION = 1;
export const DB_NAME = "AirSpiceDB";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    run: (db) => {
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
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

      // Run migrations in sequence
      for (const m of MIGRATIONS) {
        if (m.version > oldVersion && m.version <= version) {
          m.run(db, transaction);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Initialize the database connection, handling schema version checks and migrations.
 */
async function initializeDatabase(): Promise<DatabaseInitResult> {
  try {
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
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
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
      const request = store.put(project);
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
