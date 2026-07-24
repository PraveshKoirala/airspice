import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tester-provided test-runner config (issue #40). The mcp-server tests import
// the REAL engine (air-ts) and the REAL #18 browser tool specs (agent) to
// compute expected diagnostics and to assert schema parity. Alias both bare
// specifiers to their SOURCE entry -- mirroring packages/agent/vitest.config.ts
// -- so the suite runs without a prior `npm run build` of those packages and
// exercises the same source the UI bundles.
//
// NOTE: the stdio + simulate suites additionally spawn the BUILT mcp-server
// (the `airspice-mcp` bin -> dist/cli.js) as a child process; that child uses
// the packages' own module resolution (built dist), independent of these aliases.
export default defineConfig({
  resolve: {
    alias: {
      "air-ts": fileURLToPath(new URL("../air-ts/src/index.ts", import.meta.url)),
      agent: fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // Spawning + (optionally) building a child server needs headroom.
    testTimeout: 60000,
    hookTimeout: 180000,
  },
});
