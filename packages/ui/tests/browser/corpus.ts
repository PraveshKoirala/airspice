/**
 * Corpus fixture loader + report-parity comparator for the browser pipeline test
 * (issue #14 deliverable 6). Reads the golden corpus from disk at RUN TIME (Node
 * side of Playwright) — no golden-corpus design name is hard-coded in product OR
 * test source (guardrails R4). The design set is discovered by scanning each
 * design's committed report tree.
 *
 * The comparator reproduces the exporter's split contract (scripts/export_golden.py
 * `_compare_numeric_text`): report STRUCTURE (JSON keys + ordering, the
 * convergence section, everything that is not a number) must match BYTE-FOR-BYTE,
 * while numeric field VALUES are compared with a relative tolerance (the WASM
 * engine is eecircuit ngspice 45.2 vs the corpus's native 42). Numbers are NEVER
 * hand-copied — the reference is the committed report JSON.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../tests/golden_corpus", import.meta.url),
);

export interface CorpusReportCase {
  design: string;
  testId: string;
  /** The design's source XML, fed to the full browser pipeline. */
  xml: string;
  /** The committed oracle report JSON string (LF-normalized). */
  expectedReport: string;
}

/** Every (design, test) with a committed report JSON, sorted deterministically. */
export function loadReportCases(): CorpusReportCase[] {
  const cases: CorpusReportCase[] = [];
  for (const design of readdirSync(CORPUS_ROOT)) {
    const dir = join(CORPUS_ROOT, design);
    const reportsDir = join(dir, "report", "reports");
    const inputPath = join(dir, "input.air.xml");
    if (!existsSync(reportsDir) || !existsSync(inputPath)) continue;
    const xml = readFileSync(inputPath, "utf-8");
    for (const f of readdirSync(reportsDir)) {
      if (!f.endsWith(".json")) continue;
      const testId = f.slice(0, f.length - ".json".length);
      const expectedReport = readFileSync(join(reportsDir, f), "utf-8").replace(/\r\n/g, "\n");
      cases.push({ design, testId, xml, expectedReport });
    }
  }
  cases.sort((a, b) =>
    `${a.design}/${a.testId}` < `${b.design}/${b.testId}` ? -1 : 1,
  );
  return cases;
}

// A numeric token (int / float / scientific), matching the exporter's _NUM_TOKEN.
const NUM_TOKEN = /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

// Lines carrying a `time_of_min` / `time_of_max` field. The extremum TIME of a
// numerically-flat signal is engine-arbitrary (any sample is a valid extremum),
// so eecircuit and native ngspice legitimately disagree here even when the
// extremum VALUE is identical (e.g. corpus "0s" vs browser "2.28e-06s" on a flat
// 1.04211V rail). These are compared with an ABSOLUTE time tolerance, not rtol —
// this does NOT weaken the structural check (the KEY and the "s" suffix still
// match byte-exact) and reflects the physics: extremum-time is not a
// cross-engine-stable quantity on a flat waveform, the VALUE is.
const TIME_OF_FIELD_RE = /"time_of_(?:min|max)"/;

/**
 * Compare two report JSON strings the way the exporter's `_compare_numeric_text`
 * does, with one honest amendment for the browser engine:
 *   - STRUCTURE (everything that is not a number, each numeric token replaced by
 *     a sentinel) must match byte-for-byte;
 *   - `time_of_min` / `time_of_max` values are compared with an ABSOLUTE time
 *     tolerance `timeAtol` (extremum-time is engine-arbitrary on a flat signal);
 *   - every OTHER numeric field (voltages, currents) is compared within `rtol`
 *     (relative) with a small absolute floor.
 * Returns [] when they agree within contract, else human-readable diffs.
 */
export function compareReport(
  expected: string,
  actual: string,
  rtol: number,
  timeAtol = 1.0,
): string[] {
  const diffs: string[] = [];
  const expLines = expected.split("\n");
  const actLines = actual.split("\n");
  if (expLines.length !== actLines.length) {
    return [`line count differs (expected ${expLines.length}, got ${actLines.length})`];
  }
  for (let i = 0; i < expLines.length; i++) {
    const el = expLines[i]!;
    const al = actLines[i]!;
    const expStruct = el.replace(NUM_TOKEN, "\0");
    const actStruct = al.replace(NUM_TOKEN, "\0");
    if (expStruct !== actStruct) {
      diffs.push(`line ${i + 1}: STRUCTURE differs\n  expected: ${JSON.stringify(el)}\n  actual:   ${JSON.stringify(al)}`);
      continue;
    }
    const isTimeOf = TIME_OF_FIELD_RE.test(el);
    const expNums = el.match(NUM_TOKEN) ?? [];
    const actNums = al.match(NUM_TOKEN) ?? [];
    for (let j = 0; j < expNums.length; j++) {
      const en = parseFloat(expNums[j]!);
      const an = parseFloat(actNums[j]!);
      const tol = isTimeOf ? timeAtol : 1e-12 + rtol * Math.abs(en);
      if (Math.abs(en - an) > tol) {
        const kind = isTimeOf ? `abs time tol ${timeAtol}s` : `rtol=${rtol}`;
        diffs.push(`line ${i + 1}: number outside tolerance (expected ${expNums[j]}, got ${actNums[j]}, ${kind})`);
      }
    }
  }
  return diffs;
}
