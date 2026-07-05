import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Vite config for the report-pipeline Playwright harness (issue #14). Single-
 * threaded WASM (no COOP/COEP headers) so static hosting stays trivial (epic #12
 * binding decision 2). ES module workers so the sim-wasm engine worker can
 * dynamic-import eecircuit-engine as a lazy chunk.
 *
 * The aliases mirror packages/ui/vite.config.ts so the harness resolves the port
 * packages from source and eecircuit-engine from the UI's own node_modules
 * (packages/sim-wasm/node_modules is not installed in the ui CI job).
 */
export default defineConfig({
  root: fileURLToPath(new URL("./harness", import.meta.url)),
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../../../air-ts/src/index.ts", import.meta.url)),
      "sim-wasm": fileURLToPath(new URL("../../../sim-wasm/src/index.ts", import.meta.url)),
      "fast-xml-parser": fileURLToPath(
        new URL("../../node_modules/fast-xml-parser/src/fxp.js", import.meta.url),
      ),
      "eecircuit-engine": fileURLToPath(
        new URL("../../node_modules/eecircuit-engine/dist/eecircuit-engine.mjs", import.meta.url),
      ),
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
      // Allow serving the sibling port packages (air-ts, sim-wasm) whose source
      // this harness consumes via the aliases above.
      allow: [fileURLToPath(new URL("../../..", import.meta.url))],
    },
  },
});
