#!/usr/bin/env node
/**
 * Cross-engine simulation parity: browser-side capture (issue #15 deliverable 1).
 *
 * Drives the FULL browser simulation pipeline (compile air-ts #9 -> WASM ngspice
 * worker sim-wasm #13 -> report air-ts report.ts #14) in a REAL headless Chromium
 * over EVERY golden-corpus design that has a committed ngspice report, and writes
 * each design's browser reports to a temp output directory in the SAME layout the
 * corpus commits:
 *
 *   <out>/<design>/report/reports/<test>.json     the browser (eecircuit 45.2) report
 *   <out>/ENGINE_VERSIONS.json                     the WASM engine + ngspice versions
 *
 * The native (ngspice 42) reference is the ALREADY-COMMITTED corpus tree; this
 * script produces only the browser side. `scripts/compare_reports.py` then diffs
 * the two trees against `tests/golden_corpus/tolerances.json`.
 *
 * WHY A REAL BROWSER (not jsdom): the WASM engine runs in a Web Worker that
 * jsdom/node cannot host, and epic #12 binding decision 1 forbids running it on
 * any thread but the worker. So parity MUST be measured in a real browser — the
 * same environment users run in — via the existing Vite harness
 * (packages/ui/tests/browser/vite.config.ts + harness/main.ts), which exposes
 * `window.__air.runDesign(xml)`. This script REUSES that harness read-only; it
 * does not modify any port package (keeps the PR out of the fixture/port-
 * separation rule R1 — it touches the corpus for tolerances.json only, no port).
 *
 * ZERO BACKEND: the harness runs entirely client-side (no `air serve`), matching
 * the epic invariant. The only server is the Vite dev server that serves the
 * harness bundle.
 *
 * DETERMINISM: designs are discovered by scanning the committed corpus (no design
 * name is hard-coded — guardrails R4) and processed in sorted order; the engine
 * versions are read from source, not sniffed at runtime.
 *
 * Usage:
 *   node scripts/sim_parity.mjs --out <dir>   write browser reports to <dir>
 *   node scripts/sim_parity.mjs               write to a fresh temp dir, print it
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CORPUS_ROOT = join(REPO_ROOT, "tests", "golden_corpus");
const GROUND_TRUTH_ROOT = join(REPO_ROOT, "tests", "ground_truth");
const UI_DIR = join(REPO_ROOT, "packages", "ui");

// @playwright/test + vite live in packages/ui (the browser-pipeline package),
// not at the repo root, so resolve them from there rather than from this
// script's directory. This lets `node scripts/sim_parity.mjs` run from anywhere
// (the CI job invokes it with cwd = repo root).
const uiRequire = createRequire(pathToFileURL(join(UI_DIR, "package.json")));
// @playwright/test is CommonJS; require it (named `chromium` export) rather than
// dynamic-import its resolved file (whose named exports land under .default).
const { chromium } = uiRequire("@playwright/test");
const VITE_CONFIG = join(UI_DIR, "tests", "browser", "vite.config.ts");
const ENGINE_WORKER = join(REPO_ROOT, "packages", "sim-wasm", "src", "engine.worker.ts");
const EECIRCUIT_PKG = join(UI_DIR, "node_modules", "eecircuit-engine", "package.json");

// --------------------------------------------------------------------------- //
// Corpus discovery — every (design) with a committed report tree, sorted.
// No corpus design name is hard-coded (guardrails R4): the set is discovered.
// --------------------------------------------------------------------------- //

function discoverDesigns() {
  const designs = [];
  for (const design of readdirSync(CORPUS_ROOT).sort()) {
    const dir = join(CORPUS_ROOT, design);
    const reportsDir = join(dir, "report", "reports");
    const inputPath = join(dir, "input.air.xml");
    if (!existsSync(reportsDir) || !existsSync(inputPath)) continue;
    const tests = readdirSync(reportsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    if (tests.length === 0) continue;
    designs.push({ design, xml: readFileSync(inputPath, "utf-8"), tests });
  }
  return designs;
}

// --------------------------------------------------------------------------- //
// Ground-truth discovery (issue #15 amendment 3) — the hand-derived physics
// circuits (issue #41). These are the SECOND comparison set: both engines must
// satisfy the same hand-worked expectations, not merely agree with each other.
// We capture the browser side here (report JSON + waveform CSVs); the native
// side is validated by the required `ground-truth` job (Python oracle + real
// ngspice), and compare_reports.py applies the physics windows to the browser
// output. Only `outcome:pass` circuits are captured (expected-fail modes are
// oracle-compiler concerns, out of the browser-engine's scope).
// --------------------------------------------------------------------------- //

function discoverGroundTruth() {
  if (!existsSync(GROUND_TRUTH_ROOT)) return [];
  const circuits = [];
  for (const name of readdirSync(GROUND_TRUTH_ROOT).sort()) {
    const dir = join(GROUND_TRUTH_ROOT, name);
    const designPath = join(dir, "design.air.xml");
    const expectedPath = join(dir, "expected.json");
    if (!existsSync(designPath) || !existsSync(expectedPath)) continue;
    let expected;
    try {
      expected = JSON.parse(readFileSync(expectedPath, "utf-8"));
    } catch {
      continue;
    }
    if (expected.outcome !== "pass") continue;
    circuits.push({ name, xml: readFileSync(designPath, "utf-8"), test: expected.test });
  }
  return circuits;
}

// --------------------------------------------------------------------------- //
// Engine version discovery — read the pinned constants from SOURCE (the single
// source of truth in sim-wasm), cross-checked against the installed eecircuit
// package. This is what the CI job records in its summary so a version bump is
// visible (issue #15 deliverable 4). Reading from source keeps this a pure,
// deterministic function — no runtime sniffing, no guessing.
// --------------------------------------------------------------------------- //

function readEngineVersions() {
  const worker = readFileSync(ENGINE_WORKER, "utf-8");
  const engineMatch = worker.match(/ENGINE_VERSION\s*=\s*"([^"]+)"/);
  const ngspiceMatch = worker.match(/NGSPICE_VERSION\s*=\s*"([^"]+)"/);
  const engineVersion = engineMatch ? engineMatch[1] : "unknown";
  const ngspiceVersion = ngspiceMatch ? ngspiceMatch[1] : "unknown";

  let installedEecircuit = "unknown";
  try {
    installedEecircuit = JSON.parse(readFileSync(EECIRCUIT_PKG, "utf-8")).version ?? "unknown";
  } catch {
    /* eecircuit not installed in this checkout; the source pin still stands. */
  }

  // Cross-check: the installed eecircuit package should match the sim-wasm pin.
  const mismatch = installedEecircuit !== "unknown" && installedEecircuit !== engineVersion;
  return { engine: "eecircuit-engine", engineVersion, ngspiceVersion, installedEecircuit, mismatch };
}

// --------------------------------------------------------------------------- //
// Vite harness server lifecycle.
// --------------------------------------------------------------------------- //

async function pickPort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite harness server did not come up at ${url} within ${timeoutMs}ms`);
}

function startViteServer(port) {
  // Reuse the EXISTING #14 harness Vite config so this script consumes the same
  // pipeline the ui-sim job does — no duplicate build wiring. Resolve the vite
  // JS entry from packages/ui and run it with `node` directly: this avoids the
  // Windows `spawn EINVAL` on npx.cmd (shell quirk) and needs no shell at all,
  // so it behaves identically on Linux CI and a local Windows dev box.
  // Vite's package.json does not export ./bin/*, so resolve the package root
  // (via its package.json) and join the bin entry on disk.
  const viteBin = join(dirname(uiRequire.resolve("vite/package.json")), "bin", "vite.js");
  const child = spawn(
    process.execPath,
    [viteBin, "--config", VITE_CONFIG, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: UI_DIR, stdio: ["ignore", "pipe", "pipe"], shell: false },
  );
  child.stdout.on("data", (d) => process.env.SIM_PARITY_VERBOSE && process.stderr.write(`[vite] ${d}`));
  child.stderr.on("data", (d) => process.env.SIM_PARITY_VERBOSE && process.stderr.write(`[vite] ${d}`));
  return child;
}

// --------------------------------------------------------------------------- //
// Main.
// --------------------------------------------------------------------------- //

function parseArgs(argv) {
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
  }
  return { out };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const outDir = out ?? mkdtempSync(join(tmpdir(), "sim-parity-browser-"));
  mkdirSync(outDir, { recursive: true });

  const designs = discoverDesigns();
  if (designs.length === 0) {
    console.error("FAIL: no corpus design with a committed report was found.");
    process.exit(1);
  }

  const versions = readEngineVersions();
  writeFileSync(join(outDir, "ENGINE_VERSIONS.json"), JSON.stringify(versions, null, 2) + "\n", "utf-8");

  const port = await pickPort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = startViteServer(port);

  let exitCode = 0;
  let browser = null;
  try {
    await waitForServer(baseURL, 180_000);
    browser = await chromium.launch();
    const page = await browser.newPage();
    // Only UNCAUGHT page exceptions are fatal here. Do NOT treat console.error as
    // fatal: the engine legitimately echoes ngspice stderr (e.g. eecircuit's
    // singular-matrix warnings on rung 1 for the divergence-B design, before
    // the #94 ladder climbs to a converging rung) to the console; that is the
    // engine working, not a harness bug. The report content is the contract,
    // checked downstream by compare_reports.py.
    const fatalErrors = [];
    page.on("pageerror", (err) => fatalErrors.push(`UNCAUGHT: ${err.message}`));
    // Fail loudly if the harness ever reaches out to a network origin other than
    // the local Vite dev server — the epic's zero-backend invariant.
    page.on("request", (req) => {
      const u = req.url();
      if (!u.startsWith(baseURL) && !u.startsWith("data:") && !u.startsWith("blob:")) {
        fatalErrors.push(`NON-LOCAL REQUEST (zero-backend violation): ${u}`);
      }
    });

    await page.goto(baseURL + "/");
    await page.waitForFunction(() => window.__air !== undefined, null, { timeout: 60_000 });

    const summary = [];
    for (const { design, xml, tests } of designs) {
      const outcome = await page.evaluate((designXml) => window.__air.runDesign(designXml), xml);
      const reportsOut = join(outDir, design, "report", "reports");
      mkdirSync(reportsOut, { recursive: true });
      let written = 0;
      for (const testId of tests) {
        const reportJson = outcome.reportJson[testId];
        if (reportJson === undefined) {
          console.error(
            `FAIL: browser produced no report for ${design}/${testId}. notes: ${outcome.notes.join(" | ")}`,
          );
          exitCode = 1;
          continue;
        }
        // Byte-for-byte the serialized report (sort_keys) so compare_reports.py
        // diffs against the corpus report line-for-line.
        writeFileSync(join(reportsOut, `${testId}.json`), reportJson, "utf-8");
        written += 1;
      }
      summary.push(`  ${design}: ${written}/${tests.length} report(s), status=${outcome.status}`);
    }

    // Ground-truth second set (amendment 3): capture the browser side of every
    // `outcome:pass` hand-derived physics circuit — the report JSON (for DC
    // `checks`) and its waveform CSVs (for `time_checks`/`mean_checks`).
    const gtCircuits = discoverGroundTruth();
    const gtSummary = [];
    for (const { name, xml, test } of gtCircuits) {
      const outcome = await page.evaluate((designXml) => window.__air.runDesign(designXml), xml);
      const gtOut = join(outDir, "ground_truth", name);
      mkdirSync(join(gtOut, "csv"), { recursive: true });
      const reportJson = outcome.reportJson[test];
      if (reportJson === undefined) {
        // Not fatal here: a browser non-convergence on a physics circuit is a
        // known-ladder gap (#45), reported by compare_reports.py, not a crash.
        gtSummary.push(`  ${name}: NO browser report for test ${test} (notes: ${outcome.notes.join(" | ")})`);
        continue;
      }
      writeFileSync(join(gtOut, "report.json"), reportJson, "utf-8");
      let csvCount = 0;
      for (const [key, csv] of Object.entries(outcome.csv)) {
        writeFileSync(join(gtOut, "csv", `${key}.csv`), csv, "utf-8");
        csvCount += 1;
      }
      gtSummary.push(`  ${name}: report + ${csvCount} csv, status=${outcome.status}`);
    }

    if (fatalErrors.length > 0) {
      console.error("FAIL: uncaught page errors / zero-backend violations during parity capture:");
      for (const e of fatalErrors) console.error(`  ${e}`);
      exitCode = 1;
    }

    console.log(`sim_parity: captured browser reports for ${designs.length} corpus design(s):`);
    for (const line of summary) console.log(line);
    console.log(`sim_parity: captured browser ground-truth for ${gtCircuits.length} circuit(s):`);
    for (const line of gtSummary) console.log(line);
    console.log(
      `engine: ${versions.engine} ${versions.engineVersion} (ngspice ${versions.ngspiceVersion})` +
        (versions.mismatch ? ` [WARN installed=${versions.installedEecircuit}]` : ""),
    );
    console.log(`output: ${outDir}`);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }

  // Print the output dir on the LAST line so a caller (CI) can capture it.
  process.stdout.write(`OUT_DIR=${outDir}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
