/**
 * Corpus fixture loader for the browser parity tests. Reads the golden corpus
 * from disk at RUN TIME (Node side of Playwright), so no golden-corpus design
 * name is hard-coded in product OR test source (guardrails R4). The design set
 * is discovered by scanning each golden_corpus design's netlist.cir.
 *
 * We assert final NODE VOLTAGES from the WASM engine against the corpus report's
 * `measurements` (produced by the Python oracle + native ngspice) within rtol.
 * Numbers are NEVER hand-copied (issue guardrail) -- they are parsed from the
 * report JSON fixtures.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORPUS_ROOT = fileURLToPath(
  new URL("../../../../tests/golden_corpus", import.meta.url),
);

export interface CorpusCase {
  design: string;
  netlist: string;
  /** node name (lower-cased) -> expected volts, parsed from the report. */
  expectedVolts: Record<string, number>;
}

/** Parse an SI-suffixed engineering value like "2.5V", "1.04211V", "10mA". */
export function parseSi(text: string): number {
  const m = /^(-?[\d.]+(?:e-?\d+)?)\s*([a-zA-Zµ]*)$/.exec(text.trim());
  if (!m) return NaN;
  const value = parseFloat(m[1] as string);
  const suffix = m[2] ?? "";
  // Strip a trailing unit letter (V, A, s, Hz) leaving the SI prefix.
  const prefix = suffix.replace(/(V|A|s|Hz)$/i, "");
  const scale: Record<string, number> = {
    "": 1,
    T: 1e12, G: 1e9, Meg: 1e6, M: 1e6, k: 1e3,
    m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  };
  const factor = prefix in scale ? (scale[prefix] as number) : 1;
  return value * factor;
}

/**
 * Load selected corpus cases that are pure analog transients (have a
 * netlist.cir and a report with node-voltage measurements). `names` selects
 * which designs; each must exist. Returns cases with the netlist and the
 * expected final node voltages from the report.
 */
export function loadCorpusCases(names: string[]): CorpusCase[] {
  const cases: CorpusCase[] = [];
  for (const design of names) {
    const dir = join(CORPUS_ROOT, design);
    const netlistPath = join(dir, "netlist.cir");
    if (!existsSync(netlistPath)) {
      throw new Error(`corpus case ${design} has no netlist.cir`);
    }
    const netlist = readFileSync(netlistPath, "utf-8");

    // Find the report JSON under report/reports/*.json and read measurements.
    const reportsDir = join(dir, "report", "reports");
    const reportFiles = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((f) => f.endsWith(".json"))
      : [];
    if (reportFiles.length === 0) {
      throw new Error(`corpus case ${design} has no report JSON`);
    }
    const report = JSON.parse(
      readFileSync(join(reportsDir, reportFiles[0] as string), "utf-8"),
    ) as { measurements?: Record<string, string> };

    const expectedVolts: Record<string, number> = {};
    for (const [name, valueText] of Object.entries(report.measurements ?? {})) {
      // Only node voltages: currents "i(...)" and the synthetic "gnd" alias are
      // skipped (gnd is the 0-node; ngspice does not emit v(0)). Voltage entries
      // are bare node names in the report (e.g. "mid", "vin", "battery_sense").
      if (name.startsWith("i(") || name === "gnd") continue;
      const volts = parseSi(valueText);
      if (!Number.isNaN(volts)) expectedVolts[name.toLowerCase()] = volts;
    }
    cases.push({ design, netlist, expectedVolts });
  }
  return cases;
}

/** Names of the corpus designs discovered on disk (for diagnostics). */
export function discoverDesigns(): string[] {
  return readdirSync(CORPUS_ROOT).filter((d) =>
    existsSync(join(CORPUS_ROOT, d, "netlist.cir")),
  );
}
