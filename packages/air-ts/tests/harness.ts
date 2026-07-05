/**
 * Shared parity harness (epic #6 requirement 2: ONE fixture-driven utility that
 * every child issue extends). It loads the golden corpus from disk and diffs
 * air-ts output against the fixture files BYTE-FOR-BYTE.
 *
 * Design-name discovery is dynamic (readdir of the corpus). No corpus design
 * name is hard-coded in any .ts file -- that both keeps the harness honest
 * (adding a design to the corpus automatically extends the suite) and keeps the
 * package clear of AGENTS.md rule 13 / guardrails R4 (a corpus name literal in
 * product-or-test source is a special-casing smell).
 *
 * fs is used ONLY here in test code; the library source under src/ never touches
 * the filesystem (epic #6: browser/Worker-safe).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/air-ts/tests -> repo root is three levels up. */
export const CORPUS_DIR = join(HERE, "..", "..", "..", "tests", "golden_corpus");

export interface CorpusDesign {
  name: string;
  dir: string;
  inputPath: string;
  modelPath: string;
  canonicalPath: string;
  diagnosticsPath: string;
  /**
   * SPICE netlist fixture (`<design>/netlist.cir`). Present ONLY for designs the
   * oracle compiled -- i.e. valid designs (no error-severity diagnostics). A
   * failing design's absence here IS the expected output (#9 refusal gate).
   */
  netlistPath: string;
  /** True iff `netlist.cir` exists on disk for this design. */
  hasNetlist: boolean;
  /**
   * SPICE probes descriptor fixture (`<design>/report/probes.json`). Present
   * only for valid designs whose default profile has an ngspice backend.
   */
  probesPath: string;
  /** True iff `report/probes.json` exists on disk for this design. */
  hasProbes: boolean;
  /**
   * Graph fixture (`<design>/graph.json`). Present for EVERY design -- the
   * graph compiler runs before validation, so failing designs have one too
   * (#10 parity target).
   */
  graphPath: string;
}

/** Discover every corpus design directory that has an input.air.xml. */
export function discoverDesigns(): CorpusDesign[] {
  const entries = readdirSync(CORPUS_DIR, { withFileTypes: true });
  const designs: CorpusDesign[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(CORPUS_DIR, entry.name);
    const inputPath = join(dir, "input.air.xml");
    if (!existsSync(inputPath)) continue;
    const netlistPath = join(dir, "netlist.cir");
    const probesPath = join(dir, "report", "probes.json");
    designs.push({
      name: entry.name,
      dir,
      inputPath,
      modelPath: join(dir, "model.json"),
      canonicalPath: join(dir, "canonical.air.xml"),
      diagnosticsPath: join(dir, "diagnostics.json"),
      netlistPath,
      hasNetlist: existsSync(netlistPath),
      probesPath,
      hasProbes: existsSync(probesPath),
      graphPath: join(dir, "graph.json"),
    });
  }
  designs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return designs;
}

export function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

/**
 * Byte-level comparison result. `equal` is a strict string identity check (the
 * files are read as UTF-8; identity of the decoded strings implies identical
 * bytes for these UTF-8 fixtures). On mismatch, `firstDiffIndex` and a small
 * context window locate the divergence for a readable failure message.
 */
export interface ByteDiff {
  equal: boolean;
  firstDiffIndex: number;
  message: string;
}

export function byteDiff(actual: string, expected: string, label: string): ByteDiff {
  if (actual === expected) {
    return { equal: true, firstDiffIndex: -1, message: "" };
  }
  const n = Math.min(actual.length, expected.length);
  let i = 0;
  for (; i < n; i++) {
    if (actual[i] !== expected[i]) break;
  }
  const ctx = 60;
  const got = actual.slice(Math.max(0, i - ctx), i + ctx);
  const want = expected.slice(Math.max(0, i - ctx), i + ctx);
  const message =
    `${label}: byte mismatch at index ${i} ` +
    `(actual length ${actual.length}, expected length ${expected.length})\n` +
    `  actual  : ${JSON.stringify(got)}\n` +
    `  expected: ${JSON.stringify(want)}`;
  return { equal: false, firstDiffIndex: i, message };
}
