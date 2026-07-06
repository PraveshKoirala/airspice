import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
//
// Workspaces refactor (issue #85): the UI no longer aliases air-ts / agent /
// sim-wasm / fast-xml-parser / eecircuit-engine to per-consumer copies. All
// four sibling packages are real npm workspaces (root package.json `workspaces`
// array), and their transitive deps (fast-xml-parser via air-ts,
// eecircuit-engine via sim-wasm) are hoisted by npm the standard way. Vite's
// default resolution walks the workspace layout and finds a single copy of
// each, eliminating the drift risk called out in #85 (a package pinning
// fast-xml-parser@^5 while a consumer pinned ^6 used to silently ship one
// version and test another).
//
// We still keep source aliases for the three intra-repo packages so the dev
// server hot-reloads across the workspace boundary WITHOUT a per-package tsc
// -b -w. Production `vite build` also uses these aliases (bundling from the
// TypeScript source) -- Vite compiles the .ts on the fly, so no separate
// air-ts / agent / sim-wasm build step is required before `vite build`.
// The aliases carry NO third-party overrides (removed), so npm workspace
// resolution owns fast-xml-parser + eecircuit-engine end to end.
export default defineConfig(({ mode }) => {
  // Read VITE_ENGINE at config time from .env files + process.env so the engine
  // adapter alias below (issue #86) is a genuine build-time constant.
  // `loadEnv(mode, cwd, '')` merges process.env (which is where a CLI-provided
  // `VITE_ENGINE=local npm run build` lands) with any `.env`/`.env.<mode>` file.
  const env = loadEnv(mode, process.cwd(), '');
  const engineMode = (env.VITE_ENGINE ?? '').toString().trim().toLowerCase() === 'local' ? 'local' : 'server';
  // The engine-adapter seam (issue #86): swap the `@engine-adapter` specifier
  // used by `src/engine/index.ts` for either the local or server adapter file
  // at build time. Only the chosen adapter's transitive static-import graph
  // (and, in local mode, its worker + sim-wasm + eecircuit-engine chunks)
  // enters the bundle -- the other side is genuinely tree-shaken out, not
  // just lazy.
  const engineAdapterFile = engineMode === 'local'
    ? new URL('./src/engine/adapter.local.ts', import.meta.url)
    : new URL('./src/engine/adapter.server.ts', import.meta.url);

  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Engine-adapter build-time seam (issue #86). Resolved above from
        // VITE_ENGINE so the unused adapter is dead-code-eliminated.
        '@engine-adapter': fileURLToPath(engineAdapterFile),
        // Source consumption of the sibling workspace packages: Vite/Rollup
        // transpiles the .ts entry directly (issue #10 / #17 / #13). Same
        // effect as consuming the built dist/, but with per-file HMR in
        // `vite dev`. Node-side resolution (Vitest, tsc -b in agent/air-ts,
        // etc.) uses the real workspace symlink -- these aliases only bind
        // inside Vite.
        'air-ts': fileURLToPath(new URL('../air-ts/src/index.ts', import.meta.url)),
        'agent': fileURLToPath(new URL('../agent/src/index.ts', import.meta.url)),
        'sim-wasm': fileURLToPath(new URL('../sim-wasm/src/index.ts', import.meta.url)),
      },
    },
    // Module workers so the air-ts engine worker can `import` air-ts as ESM.
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      // eecircuit-engine (the WASM ngspice engine used by the dev-only
      // /sim-lab route via sim-wasm) is ~20MB with the WASM inlined. Excluding
      // it from Vite's dep pre-bundler keeps the engine.worker.ts dynamic
      // import() resolving it as a lazy chunk (not eagerly optimized), which
      // is how the sim-wasm harness build produces a separate WASM chunk. It
      // is only loaded inside the Web Worker, on demand.
      exclude: ['eecircuit-engine'],
    },
    server: {
      fs: {
        // Allow serving files from the sibling workspace packages (air-ts,
        // agent, sim-wasm) whose SOURCE we consume via the aliases above.
        // Vite's dev server restricts @fs reads to the project root by
        // default; the sim-wasm engine worker
        // (packages/sim-wasm/src/engine.worker.ts) lives outside it, so the
        // dev-only /sim-lab route needs the monorepo packages/ dir
        // allow-listed.
        allow: [fileURLToPath(new URL('..', import.meta.url))],
      },
    },
  };
})
