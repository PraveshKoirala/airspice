import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The tool runtime (issue #18) consumes the air-ts engine. Alias it to its
  // SOURCE entry -- exactly as packages/ui does -- so this package's Vitest run
  // exercises the tool runtime + the deterministic gate against the REAL air-ts
  // normalize/validate/patch (the invariant is tested against the real
  // validator, not a stub). air-ts's `fast-xml-parser` dep is pinned to the
  // agent's own copy (a devDependency) because packages/air-ts/node_modules is
  // NOT installed in the `agent` CI job (npm ci in packages/agent only).
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../air-ts/src/index.ts", import.meta.url)),
      "fast-xml-parser": fileURLToPath(
        new URL("./node_modules/fast-xml-parser/src/fxp.js", import.meta.url),
      ),
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
