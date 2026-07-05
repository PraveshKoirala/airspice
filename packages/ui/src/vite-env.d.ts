/// <reference types="vite/client" />

/**
 * Build-time env the UI reads (issue #10). `VITE_ENGINE` selects the engine
 * backing the facade: "local" (air-ts in a Web Worker, zero backend) or
 * "server" (the FastAPI backend over axios). Unset === "server" (the default
 * until M2). Declared here so `import.meta.env.VITE_ENGINE` type-checks under
 * strict TS.
 */
interface ImportMetaEnv {
  readonly VITE_ENGINE?: 'local' | 'server';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
