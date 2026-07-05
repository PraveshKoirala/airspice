import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for sim-wasm browser tests (issue #13 deliverable 8/9).
 *
 * jsdom/node cannot faithfully run a WASM Web Worker, so the engine's real
 * behavior -- corpus parity, cancellation, error mapping, main-thread
 * non-blocking -- is verified in REAL browsers. The acceptance criteria name
 * Chrome AND Firefox for the divider; both run here.
 *
 * The harness is a Vite dev server (tests/browser/vite.config.ts). No COOP/COEP
 * headers: the single-threaded build needs none (binding decision 2).
 */
export default defineConfig({
  testDir: "./tests/browser",
  testMatch: /.*\.spec\.ts/,
  // WASM cold-start + a 2s transient can be slow; give runs headroom.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5178",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "npx vite --config tests/browser/vite.config.ts --host 127.0.0.1 --port 5178 --strictPort",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        // Belt-and-suspenders for CI containers: Firefox's content sandbox uses
        // unprivileged user namespaces, which container seccomp profiles block
        // (EPERM on clone()). The workflow relaxes seccomp; these prefs also
        // disable the content sandbox so the launch cannot fail on that path.
        // No effect on the simulation semantics under test.
        launchOptions: {
          firefoxUserPrefs: {
            "security.sandbox.content.level": 0,
          },
        },
      },
    },
  ],
});
