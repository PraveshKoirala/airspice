import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment for the UNIT tests: protocol/diagnostics/result/client
    // logic against a STUB worker (no WASM). Browser-dependent tests (real WASM
    // engine, corpus parity, cancellation) run under Playwright, NOT here --
    // jsdom/node cannot run a WASM Web Worker faithfully (issue deliverable 8).
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    globals: false,
  },
});
