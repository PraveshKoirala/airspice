import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: the corpus parity harness reads fixtures from disk.
    // The library source under src/ never touches fs; only test helpers do.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
