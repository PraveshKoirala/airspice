import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The UI consumes the TypeScript engine (packages/air-ts) through its
      // source entry, aliased here (issue #10 / epic #6). air-ts is strict ESM
      // TypeScript with zero DOM dependency, so Vite compiles + bundles it (and
      // its worker import) directly -- no separate build/publish step, which
      // keeps the `ui` CI job (npm ci in packages/ui only) working.
      'air-ts': fileURLToPath(new URL('../air-ts/src/index.ts', import.meta.url)),
      // The BYOK agent layer (packages/agent, issue #17) is consumed the same
      // way: source-aliased, strict ESM, browser-safe, zero server. Vite compiles
      // + bundles it directly so the `ui` CI job (npm ci in packages/ui only)
      // needs no separate build/publish of the agent package.
      'agent': fileURLToPath(new URL('../agent/src/index.ts', import.meta.url)),
      // air-ts source imports `fast-xml-parser`. Pin it to the UI's own copy so
      // Vite (and the worker bundle) resolves it from packages/ui/node_modules
      // -- packages/air-ts/node_modules is NOT installed in the `ui` CI job.
      'fast-xml-parser': fileURLToPath(
        new URL('./node_modules/fast-xml-parser/src/fxp.js', import.meta.url),
      ),
      // The sim-wasm client (issue #13) is consumed through its source entry,
      // aliased here. sim-wasm is worker-only: the WASM engine loads ONLY inside
      // its Web Worker (never the main thread), and the ~20MB WASM is a lazy
      // Vite chunk. The dev-only /sim-lab route uses it directly; the local
      // simulation pipeline (issue #14, engine/simulate.ts) uses it behind a
      // dynamic import so the engine chunk still loads only on first Run.
      'sim-wasm': fileURLToPath(new URL('../sim-wasm/src/index.ts', import.meta.url)),
      // sim-wasm's engine.worker dynamic-imports `eecircuit-engine`. Pin it to
      // the UI's OWN copy (a ui devDependency) so the worker bundle resolves it
      // from packages/ui/node_modules -- packages/sim-wasm/node_modules is NOT
      // installed in the `ui` CI job (npm ci in packages/ui only), exactly as
      // the fast-xml-parser alias above does for air-ts's dependency.
      'eecircuit-engine': fileURLToPath(
        new URL('./node_modules/eecircuit-engine/dist/eecircuit-engine.mjs', import.meta.url),
      ),
    },
  },
  // Module workers so the air-ts engine worker can `import` air-ts as ESM.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // eecircuit-engine (the WASM ngspice engine used by the dev-only /sim-lab
    // route via sim-wasm) is ~20MB with the WASM inlined. Excluding it from
    // Vite's dep pre-bundler keeps the engine.worker.ts dynamic import()
    // resolving it as a lazy chunk (not eagerly optimized), which is how the
    // sim-wasm harness build produces a separate WASM chunk. It is only loaded
    // inside the Web Worker, on demand.
    exclude: ['eecircuit-engine'],
  },
  server: {
    fs: {
      // Allow serving files from the sibling port packages (air-ts, sim-wasm)
      // whose source we consume via the aliases above. Vite's dev server
      // restricts @fs reads to the project root by default; the sim-wasm engine
      // worker (packages/sim-wasm/src/engine.worker.ts) lives outside it, so the
      // dev-only /sim-lab route needs the monorepo packages/ dir allow-listed.
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
})
