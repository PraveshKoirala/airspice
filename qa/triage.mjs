// Triage the circuit-run results: cluster verdicts, surface bug/review groups
// with representative evidence, and print MCU coverage. Read-only.
//
//   node qa/triage.mjs [resultsFile]

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "qa/circuit-corpus/results/results.jsonl";
const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const byVerdict = {};
for (const r of rows) (byVerdict[r.verdict] ??= []).push(r);

console.log(`# Triage of ${rows.length} circuits\n`);
console.log("## Verdict counts");
for (const [v, list] of Object.entries(byVerdict).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(3)}  ${v}`);
}

// Success metrics.
const mcuRows = rows.filter((r) => r.category === "mcu");
const mcuOk = mcuRows.filter((r) => r.applied && r.firmwarePresent);
const perMcuOk = {};
for (const r of mcuOk) perMcuOk[r.mcu] = (perMcuOk[r.mcu] || 0) + 1;
console.log(`\n## MCU coverage`);
console.log(`  MCU circuits built+rendered+firmware: ${mcuOk.length}/${mcuRows.length}`);
console.log(`  per MCU: ${JSON.stringify(perMcuOk)}`);
console.log(`  sim passed (all): ${rows.filter((r) => r.simStatus === "passed").length}`);
console.log(`  applied+rendered (all): ${rows.filter((r) => r.applied && r.compCount > 0).length}/${rows.length}`);

// Bug + review clusters with evidence.
const actionable = Object.entries(byVerdict).filter(
  ([v]) => v.startsWith("bug") || v.startsWith("review") || v === "harness-error" || v.startsWith("agent-fail"),
);
for (const [v, list] of actionable.sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n## ${v}  (${list.length})`);
  // Sub-cluster by a normalized detail signature.
  const sig = {};
  for (const r of list) {
    const key = normalize(r.bugDetail || (r.consoleErrors && r.consoleErrors[0]) || r.error || r.simStatus || "");
    (sig[key] ??= []).push(r);
  }
  for (const [k, group] of Object.entries(sig).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  [${group.length}] ${k.slice(0, 160)}`);
    console.log(`       e.g. ${group.slice(0, 4).map((r) => r.id).join(", ")}`);
  }
}

function normalize(s) {
  return String(s)
    .replace(/\b(R_?\w+|C_?\w+|V\w*|U_?\w+|LED\d*|Q\d|net\w*|GPIO\d+|\d+(\.\d+)?[a-zA-Z%]*)\b/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}
