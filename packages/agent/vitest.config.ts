import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The tool runtime (issue #18) consumes the air-ts engine. Alias it to its
// SOURCE entry so this package's Vitest run exercises the tool runtime + the
// deterministic gate against the REAL air-ts normalize/validate/patch (the
// invariant is tested against the real validator, not a stub).
//
// Workspaces refactor (issue #85): air-ts is now a real workspace dependency,
// so Node/Vitest will resolve `air-ts` via the workspace symlink and pick up
// air-ts's own fast-xml-parser through npm's ordinary hoisted resolution -- no
// more per-consumer pin. We KEEP the source alias here (not the built dist)
// so the tests exercise the same source Vite bundles for the UI, and to avoid
// a `npm run build` step before `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../air-ts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    // Node environment: providers are exercised against a mocked global `fetch`,
    // the key vault against an in-memory Storage stub, and the tool runtime
    // against real air-ts + a deterministic engine stub. No real network and no
    // browser -- this is the CI-safe surface. Real provider calls are manual
    // (see the PR checklist).
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
