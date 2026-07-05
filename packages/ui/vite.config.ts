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
      // air-ts source imports `fast-xml-parser`. Pin it to the UI's own copy so
      // Vite (and the worker bundle) resolves it from packages/ui/node_modules
      // -- packages/air-ts/node_modules is NOT installed in the `ui` CI job.
      'fast-xml-parser': fileURLToPath(
        new URL('./node_modules/fast-xml-parser/src/fxp.js', import.meta.url),
      ),
    },
  },
  // Module workers so the air-ts engine worker can `import` air-ts as ESM.
  worker: {
    format: 'es',
  },
})
