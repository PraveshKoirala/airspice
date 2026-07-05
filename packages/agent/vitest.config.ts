import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: providers are exercised against a mocked global `fetch`,
    // and the key vault is tested against an in-memory Storage stub. No real
    // network and no browser are needed -- this is the CI-safe surface. Real
    // provider calls are manual (see the PR checklist).
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
  },
});
