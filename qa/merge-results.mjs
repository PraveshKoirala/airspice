// Merge the original run with the Gemini re-run: for each spec, the re-run
// result (if present) supersedes the original (it was re-run precisely because
// the original was rate-limited or needed a fix). Prints the final tally +
// MCU coverage and writes merged.jsonl.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const load = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const orig = load("qa/circuit-corpus/results/results.jsonl");
const rerun = load("qa/circuit-corpus/results-rerun/results.jsonl");

const byId = new Map();
for (const r of orig) byId.set(r.id, { ...r, _src: "orig" });
for (const r of rerun) byId.set(r.id, { ...r, _src: "rerun" }); // rerun wins

const merged = [...byId.values()];
writeFileSync("qa/circuit-corpus/results/merged.jsonl", merged.map((r) => JSON.stringify(r)).join("\n") + "\n");

const c = {};
for (const r of merged) c[r.verdict] = (c[r.verdict] || 0) + 1;
const mcu = merged.filter((r) => r.category === "mcu");
const mcuOk = mcu.filter((r) => r.applied && r.firmwarePresent);
const perMcu = {};
for (const r of mcuOk) perMcu[r.mcu] = (perMcu[r.mcu] || 0) + 1;
const appliedRendered = merged.filter((r) => r.applied && r.compCount > 0);
const bugs = merged.filter((r) => r.verdict.startsWith("bug") || r.verdict === "harness-error");
const rateLimited = merged.filter((r) => /cooling down|model_cooldown|quota/i.test(r.bugDetail || r.transcriptTail || ""));

console.log(`## Final merged tally (${merged.length} circuits)`);
console.log(JSON.stringify(c, null, 0));
console.log(`\nApplied + rendered:        ${appliedRendered.length}/${merged.length}`);
console.log(`MCU built+rendered+firmware: ${mcuOk.length}/${mcu.length}   per MCU: ${JSON.stringify(perMcu)}`);
console.log(`Sim passed:                ${merged.filter((r) => r.simStatus === "passed").length}`);
console.log(`Webapp bugs:               ${bugs.length}${bugs.length ? " -> " + bugs.map((b) => b.id).join(", ") : ""}`);
console.log(`Still rate-limited:        ${rateLimited.length}${rateLimited.length ? " -> " + rateLimited.map((b) => b.id).join(", ") : ""}`);
