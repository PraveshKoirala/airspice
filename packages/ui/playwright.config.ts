import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the report-pipeline browser test (issue #14 deliverable
 * 6). jsdom/node cannot run a WASM Web Worker, so the FULL browser pipeline
 * (compile -> WASM ngspice -> report) is verified in a REAL Chromium. The
 * cross-browser matrix is sim-wasm's job (#13); #14's proof is that the browser
 * produces the oracle's REPORT SCHEMA, which is engine-behaviour-independent, so
 * one real browser suffices here.
 *
 * The harness is a Vite dev server (tests/browser/vite.config.ts). No COOP/COEP
 * headers: the single-threaded WASM build needs none (epic #12 binding decision 2).
 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /.*\.spec\.ts/,
  // WASM cold-start + several transients can be slow; give runs headroom.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5179",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "npx vite --config tests/browser/vite.config.ts --host 127.0.0.1 --port 5179 --strictPort",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
