import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Vite config for the Playwright harness AND for the bundle-analysis build.
 * Single-threaded WASM (no COOP/COEP headers set here) -- static hosting stays
 * trivial (epic #12 binding decision 2). ES module workers so the engine worker
 * can dynamic-import eecircuit-engine as a lazy chunk.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
  worker: {
    format: "es",
  },
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    // Keep chunk-size warnings meaningful; the WASM chunk is large by nature.
    chunkSizeWarningLimit: 30000,
  },
  server: {
    // No cross-origin isolation headers: single-threaded build needs none.
    headers: {},
  },
});
