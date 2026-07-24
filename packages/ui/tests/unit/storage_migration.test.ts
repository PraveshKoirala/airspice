/**
 * AC#2 — Schema versioning + data-preserving migration (binding post-audit
 * amendment).
 *
 * The contract under test (PRD #26 acceptance criterion 2):
 *   "The IndexedDB database carries an integer schema version (>=1) with a
 *    registered forward-migration function for every bump. A COMMITTED snapshot
 *    of a v(N-1) database, opened by vN code, runs migrations and leaves every
 *    project intact (byte-equal XML)."
 *
 * This test wires in the committed v1 snapshot the PRD mandates:
 *   - fixture data:   packages/ui/tests/fixtures/db-v1.json
 *   - seed helper:    packages/ui/tests/fixtures/seedV1Db.ts (seedV1Database)
 * It seeds that genuine v1 database (records with NO `schemaVersion` field),
 * then opens it with the REAL current-version code (`initDatabase`) and asserts
 * the v1->v2 migration ran, every project's XML survived byte-for-byte, AND
 * every record gained `schemaVersion === CURRENT_VERSION`.
 *
 * Why it is genuine (each regression the adversary named fails it):
 *   - No version bump / CURRENT_VERSION back to 1  -> the precondition fails.
 *   - A no-op "version bump" that does NOT rewrite records -> records keep no
 *     `schemaVersion`, so the `schemaVersion === CURRENT_VERSION` assertion fails.
 *   - A lossy/normalizing migration that rewrites `xml` -> byte-equality fails.
 */

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { seedV1Database, V1_FIXTURE_PROJECTS } from "../fixtures/seedV1Db";

/** True byte-for-byte comparison of two strings (UTF-8), not just ===. */
function bytesEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

beforeEach(() => {
  // Pristine store + fresh module singletons (db.ts caches `activeDb`).
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});

describe("AC#2 schema version + forward migration", () => {
  it("exposes a schema version that admits a prior version to migrate from", async () => {
    const { CURRENT_VERSION } = await import("../../src/storage/db");
    // A v(N-1) -> vN migration can only be exercised if a prior version exists.
    // With CURRENT_VERSION === 1 the migration path has never carried data.
    expect(CURRENT_VERSION).toBeGreaterThanOrEqual(2);
  });

  it("sanity-checks the committed v1 fixture (genuine v1 shape: no schemaVersion)", () => {
    expect(V1_FIXTURE_PROJECTS.length).toBeGreaterThanOrEqual(1);
    for (const p of V1_FIXTURE_PROJECTS) {
      expect(typeof p.xml).toBe("string");
      expect(p.xml.length).toBeGreaterThan(0);
      // v1 records predate the schemaVersion field.
      expect((p as Record<string, unknown>).schemaVersion).toBeUndefined();
    }
  });

  it("migrates the COMMITTED v1 snapshot to current version: XML byte-equal + schemaVersion stamped", async () => {
    const { CURRENT_VERSION, initDatabase, getProject } = await import(
      "../../src/storage/db"
    );
    expect(CURRENT_VERSION).toBeGreaterThanOrEqual(2);

    // 1. Seed the committed v1 database (version 1, no schemaVersion on records).
    await seedV1Database();

    // 2. Open with the REAL current-version code -> runs the forward migration.
    const result = await initDatabase();
    expect(result.error).toBeNull();
    expect(result.isDowngraded).toBe(false);
    expect(result.db).not.toBeNull();
    expect(result.db!.version).toBe(CURRENT_VERSION);

    // 3. EVERY committed project survived byte-for-byte AND was migrated.
    expect(V1_FIXTURE_PROJECTS.length).toBeGreaterThanOrEqual(1);
    for (const original of V1_FIXTURE_PROJECTS) {
      const migrated = await getProject(original.id);
      expect(migrated).not.toBeNull();

      // XML preserved to the byte.
      expect(migrated!.xml).toBe(original.xml);
      expect(bytesEqual(migrated!.xml, original.xml)).toBe(true);

      // Migration actually RAN: the record now carries the current schemaVersion.
      // A no-op version bump (records untouched) leaves this undefined and fails.
      expect(
        (migrated as unknown as { schemaVersion?: number }).schemaVersion,
      ).toBe(CURRENT_VERSION);

      // Identity / auxiliary fields preserved too.
      expect(migrated!.name).toBe(original.name);
      expect(migrated!.createdAt).toBe(original.createdAt);
      expect(migrated!.updatedAt).toBe(original.updatedAt);
      if (original.thumbnailSvg !== undefined) {
        expect(migrated!.thumbnailSvg).toBe(original.thumbnailSvg);
      }
    }
  });
});
