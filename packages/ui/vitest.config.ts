import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest config for the UI package's UNIT tests (issue #27).
 *
 * The UI already has a Playwright suite under `tests/e2e/**`; those are driven
 * by `@playwright/test`, NOT vitest, so they are excluded here. Unit tests live
 * at `tests/unit/**\/*.test.ts` and run in the `node` environment: the
 * share-link codec relies only on `TextEncoder`/`TextDecoder`/`URLSearchParams`
 * /`Uint8Array` (all Node globals) and the corpus round-trip test reads
 * `examples/*` from disk via `node:fs` — no DOM is required.
 *
 * The sibling workspace packages (air-ts, agent, sim-wasm) are consumed from
 * source via the same aliases `vite.config.ts` uses, so a unit test importing
 * air-ts exercises the REAL engine, not a build artifact.
 */
export default defineConfig({
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../air-ts/src/index.ts", import.meta.url)),
      agent: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
      "sim-wasm": fileURLToPath(new URL("../sim-wasm/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    // Shim the IndexedDB globals (indexedDB, IDBKeyRange, IDBDatabase, …) into
    // the Node test process so the storage layer (packages/ui/src/storage/db.ts)
    // runs UNCHANGED under vitest — the real `idb`-style API against an in-memory
    // store, not a mock (issue #26). Applies to every unit test file; harmless
    // for the ones that never touch IndexedDB.
    setupFiles: ["fake-indexeddb/auto"],
  },
});
