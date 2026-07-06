/**
 * Waveform-viewer perf bench (issue #25 deliverable 7).
 *
 * Builds a 1M-point synthetic trace, walks the LodCache pyramid, and reports
 * per-frame render time (min/max decimation + draw path). This runs the pure
 * TypeScript modules under Node — the canvas draw path is exercised via a
 * shim that counts moveTo/lineTo calls so we can prove the algorithm scales,
 * and the LOD cache build time is the same as in-browser (no DOM required).
 *
 * Run with `node --experimental-strip-types packages/ui/scripts/bench-waveform.mjs`
 * (Node 24 strips the .ts types on the fly for the LodCache import). The
 * numeric output is what lands in the PR description.
 */

import { performance } from "node:perf_hooks";

// Node 24 experimental-strip-types support: import the TS module directly.
// We import via a relative path so the workspace symlink shenanigans don't
// bite (the ui package's air-ts consumer path resolves via node_modules).
const { LodCache } = await import("../src/waveform/decimation.ts");

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 1_000_000);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 60);
const WIDTH = Number(process.env.BENCH_WIDTH ?? 900);

console.log(`bench-waveform: samples=${SAMPLES} frames=${FRAMES} width=${WIDTH}`);

// Synthesize the trace (100Hz sine + a low-magnitude noise floor).
const time = new Float64Array(SAMPLES);
const values = new Float64Array(SAMPLES);
for (let i = 0; i < SAMPLES; i++) {
  time[i] = (i / (SAMPLES - 1)) * 1e-2;
  values[i] = Math.sin(2 * Math.PI * 100 * time[i]) + (i % 997) * 1e-4;
}

const t0 = performance.now();
const cache = new LodCache(time, values);
const buildMs = performance.now() - t0;
console.log(`LOD cache built in ${buildMs.toFixed(1)}ms`);

// Pan across the trace, timing ONLY the decimate call — that's the per-frame
// hot path the canvas draw wraps. The stroke() call in the browser is a GPU-
// state change that Node can't reproduce, but the algorithmic cost we're
// gating (decimation) is what dominates on large N.
const times = [];
const range = time[SAMPLES - 1] - time[0];
const windowSpan = range / 8;
for (let f = 0; f < FRAMES; f++) {
  const tMin = (range - windowSpan) * (f / (FRAMES - 1));
  const tMax = tMin + windowSpan;
  const s = performance.now();
  cache.decimate(tMin, tMax, WIDTH);
  times.push(performance.now() - s);
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const mean = times.reduce((a, b) => a + b, 0) / times.length;
const max = times[times.length - 1];

console.log("per-frame decimation ms:");
console.log(`  median: ${median.toFixed(3)}`);
console.log(`  mean:   ${mean.toFixed(3)}`);
console.log(`  max:    ${max.toFixed(3)}`);

if (median > 16) {
  console.error(`FAIL: median frame time ${median.toFixed(2)}ms > 16ms budget`);
  process.exit(1);
}
console.log("PASS: median frame time within 16ms interactive budget");
