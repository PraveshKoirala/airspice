/**
 * Performance-budget gate (Milestone M6, issue #30).
 *
 * A REAL gate: it gzip-measures the production bundle and FAILS (exit 1) when an
 * initial-load budget is exceeded. Budgets are on what a first paint actually
 * costs — the entry JS chunk and the CSS — NOT the ngspice WASM, which is a
 * lazily-imported chunk pulled only when the user first simulates. The gate also
 * asserts that WASM stays lazy (a separate chunk, never inlined into the entry)
 * and that the PWA offline assets ship.
 *
 * Usage:  node scripts/check_budgets.mjs            (after building the UI)
 *         BUDGET_JSON=1 node scripts/check_budgets.mjs   (machine-readable)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Gzipped-size budgets in kilobytes. Set with headroom over today's build so
// this catches regressions, not noise. Tighten as the bundle is optimized.
const BUDGETS_KB = {
  entryJsGz: Number(process.env.BUDGET_ENTRY_JS_GZ) || 700, // main entry chunk (today ~625)
  cssGz: Number(process.env.BUDGET_CSS_GZ) || 25, // all CSS (today ~8)
  initialTotalGz: Number(process.env.BUDGET_INITIAL_GZ) || 725, // entry JS + CSS (first-load transfer)
};

const distDir = path.resolve("packages/ui/dist");
const assetsDir = path.join(distDir, "assets");

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures.push(msg);
}
const failures = [];

if (!fs.existsSync(distDir) || !fs.existsSync(assetsDir)) {
  console.error("Error: packages/ui/dist not found. Run `npm --workspace ui run build` first.");
  process.exit(1);
}

const gzKb = (buf) => zlib.gzipSync(buf).length / 1024;

const files = fs.readdirSync(assetsDir).map((f) => {
  const buf = fs.readFileSync(path.join(assetsDir, f));
  return { name: f, rawKb: buf.length / 1024, gzKb: gzKb(buf) };
});

const entryJs = files.filter((f) => /^index-.*\.js$/.test(f.name));
const cssFiles = files.filter((f) => f.name.endsWith(".css"));
const wasmChunk = files.filter((f) => /eecircuit/.test(f.name));

const entryJsGz = entryJs.reduce((s, f) => s + f.gzKb, 0);
const cssGz = cssFiles.reduce((s, f) => s + f.gzKb, 0);
const initialTotalGz = entryJsGz + cssGz;

console.log("Performance budget audit (gzipped, initial load) — Milestone M6\n");
console.log(`  entry JS : ${entryJsGz.toFixed(1)} KB  (budget ${BUDGETS_KB.entryJsGz})`);
console.log(`  CSS      : ${cssGz.toFixed(1)} KB  (budget ${BUDGETS_KB.cssGz})`);
console.log(`  initial  : ${initialTotalGz.toFixed(1)} KB  (budget ${BUDGETS_KB.initialTotalGz})`);
console.log(
  `  lazy WASM: ${wasmChunk.reduce((s, f) => s + f.gzKb, 0).toFixed(1)} KB gz  (excluded — loaded on first simulate)\n`,
);

if (entryJs.length === 0) fail("no entry chunk (index-*.js) found in dist/assets");
if (entryJsGz > BUDGETS_KB.entryJsGz)
  fail(`entry JS ${entryJsGz.toFixed(1)}KB exceeds budget ${BUDGETS_KB.entryJsGz}KB`);
if (cssGz > BUDGETS_KB.cssGz) fail(`CSS ${cssGz.toFixed(1)}KB exceeds budget ${BUDGETS_KB.cssGz}KB`);
if (initialTotalGz > BUDGETS_KB.initialTotalGz)
  fail(`initial transfer ${initialTotalGz.toFixed(1)}KB exceeds budget ${BUDGETS_KB.initialTotalGz}KB`);

// WASM must stay a lazy, separate chunk (never inlined into the entry).
if (wasmChunk.length === 0)
  fail("expected the ngspice WASM to be a separate lazy chunk (eecircuit-*.js); none found");
if (entryJs.some((f) => f.gzKb > 2000))
  fail("entry chunk is implausibly large — the WASM may have been inlined into it");

// PWA offline assets must ship (issue #31 ties into the ship milestone).
for (const rel of ["manifest.json", "sw.js"]) {
  if (!fs.existsSync(path.join(distDir, rel))) fail(`missing PWA asset dist/${rel}`);
}

if (process.env.BUDGET_JSON) {
  console.log(JSON.stringify({ entryJsGz, cssGz, initialTotalGz, budgets: BUDGETS_KB, failures }, null, 2));
}

if (failures.length > 0) {
  console.error(`\nPerformance budget audit: FAILED (${failures.length} breach(es)).`);
  process.exit(1);
}
console.log("Performance budget audit: PASSED.");
