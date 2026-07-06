import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Vite config for the report-pipeline Playwright harness (issue #14). Single-
 * threaded WASM (no COOP/COEP headers) so static hosting stays trivial (epic #12
 * binding decision 2). ES module workers so the sim-wasm engine worker can
 * dynamic-import eecircuit-engine as a lazy chunk.
 *
 * Workspaces refactor (issue #85): the harness no longer aliases
 * fast-xml-parser / eecircuit-engine to per-consumer copies -- npm workspaces
 * hoist a single copy of each. The source-alias for air-ts / sim-wasm is kept
 * so Vite bundles their TS source directly (same as packages/ui/vite.config.ts).
 */
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../../../air-ts/src/index.ts", import.meta.url)),
      "sim-wasm": fileURLToPath(new URL("../../../sim-wasm/src/index.ts", import.meta.url)),
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["eecircuit-engine"] },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 30000,
  },
  server: {
    headers: {},
    fs: {
      // Allow serving the sibling workspace packages (air-ts, sim-wasm) whose
      // source this harness consumes via the aliases above.
      allow: [fileURLToPath(new URL("../../..", import.meta.url))],
    },
  },
});
