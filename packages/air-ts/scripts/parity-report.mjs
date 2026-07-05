// Standalone parity reporter (PR evidence). Runs the built validator over every
// corpus input and byte-compares against the committed diagnostics.json. Not a
// test; the vitest suite is the gate. Uses the compiled dist/ output.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateToJson } from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "..", "..", "tests", "golden_corpus");
const designs = readdirSync(CORPUS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(CORPUS, e.name, "input.air.xml")))
  .map((e) => e.name)
  .sort();

let pass = 0;
let fail = 0;
for (const name of designs) {
  const dir = join(CORPUS, name);
  const input = readFileSync(join(dir, "input.air.xml"), "utf-8");
  const expected = readFileSync(join(dir, "diagnostics.json"), "utf-8");
  const actual = validateToJson(input);
  const ok = actual === expected;
  const nDiag = JSON.parse(expected).diagnostics.length;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} (${nDiag} diagnostics)`);
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass}/${designs.length} diagnostics.json byte-identical` + (fail ? ` (${fail} FAILED)` : ""));
process.exit(fail ? 1 : 0);
