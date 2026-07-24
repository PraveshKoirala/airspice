/**
 * Interop round-trip gate (Milestone M7, issues #33/#34).
 *
 * A REAL gate over the KiCad exporter and SPICE importer:
 *   1. Curated designs: parse → validate (must be error-free) → KiCad export
 *      (must be a balanced S-expression with lib_symbols and a label per net) →
 *      compile to SPICE → RE-IMPORT → the re-imported design must validate clean
 *      and preserve the R/C/V device count.
 *   2. Seeded fuzz: generate random resistor-ladder SPICE decks, import them
 *      (must validate clean, drop nothing), and export to KiCad (must stay
 *      balanced). A fixed seed makes failures reproducible.
 *
 * Exits non-zero on any failure. Run after building air-ts:
 *   npm run build:air-ts && node scripts/fuzz_interop.mjs [--cases N] [--seed S]
 */
import {
  parse,
  validate,
  hasErrors,
  exportKicad,
  compileDesign,
  importSpiceNetlist,
} from "../packages/air-ts/dist/index.js";

const argv = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
};
const CASES = getArg("--cases", 200);
let seed = getArg("--seed", 1) >>> 0;
// Deterministic LCG (numerical recipes) so a fuzz failure reproduces exactly.
const rand = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

let failures = 0;
const fail = (ctx, msg) => {
  failures++;
  console.error(`  ✗ [${ctx}] ${msg}`);
};

function parensBalanced(s) {
  let depth = 0, inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "(") depth++;
    else if (!inStr && ch === ")") { if (--depth < 0) return false; }
  }
  return depth === 0 && !inStr;
}

function checkKicad(ctx, ir) {
  const res = exportKicad(ir);
  if (!res.text.startsWith("(kicad_sch (version 20231120)")) fail(ctx, "KiCad header missing");
  if (!parensBalanced(res.text)) fail(ctx, "KiCad S-expression is not balanced");
  if (!res.text.includes("(lib_symbols")) fail(ctx, "KiCad export has no lib_symbols");
  // every net must appear as a connectable label.
  for (const net of ir.nets.keys()) {
    if (!res.text.includes(`(label "${net}"`)) fail(ctx, `net '${net}' has no KiCad label`);
  }
  if (res.symbols !== ir.components.size) fail(ctx, "KiCad symbol count != component count");
}

// ---------------------------------------------------------------- curated ---
const curated = [
  {
    name: "divider",
    xml: `<system name="divider" ir_version="0.1"><metadata><title>D</title></metadata>
      <nets><net id="gnd" role="ground"/><net id="vcc" role="power"/><net id="mid" role="signal"/></nets>
      <components>
        <component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="vcc"/><pin name="n" net="gnd"/></component>
        <component id="R1" type="resistor"><value>10k</value><pin name="1" net="vcc"/><pin name="2" net="mid"/></component>
        <component id="R2" type="resistor"><value>10k</value><pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
      </components>
      <tests><test id="t"><run duration="1ms"/></test></tests>
      <simulation_profiles><profile id="default"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles></system>`,
    devices: 3,
  },
  {
    name: "rc",
    xml: `<system name="rc" ir_version="0.1"><metadata><title>RC</title></metadata>
      <nets><net id="gnd" role="ground"/><net id="vcc" role="power"/><net id="out" role="signal"/></nets>
      <components>
        <component id="V1" type="voltage_source"><value>3.3V</value><pin name="p" net="vcc"/><pin name="n" net="gnd"/></component>
        <component id="R1" type="resistor"><value>1k</value><pin name="1" net="vcc"/><pin name="2" net="out"/></component>
        <component id="C1" type="capacitor"><value>100nF</value><pin name="1" net="out"/><pin name="2" net="gnd"/></component>
      </components>
      <tests><test id="t"><run duration="1ms"/></test></tests>
      <simulation_profiles><profile id="default"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles></system>`,
    devices: 3,
  },
];

console.log("Interop round-trip gate — Milestone M7\n");
console.log("Curated designs:");
for (const c of curated) {
  const ir = parse(c.xml);
  if (hasErrors(validate(c.xml))) fail(c.name, "source design has validation errors");
  checkKicad(c.name, ir);

  const artifacts = compileDesign(c.xml);
  if (!artifacts) {
    fail(c.name, "compileDesign refused a valid design");
  } else {
    const back = importSpiceNetlist(artifacts.netlist);
    if (hasErrors(validate(back.airXml))) fail(c.name, "re-imported design has validation errors");
    if (back.components.length !== c.devices)
      fail(c.name, `round-trip device count ${back.components.length} != ${c.devices}`);
  }
  console.log(`  ${failures === 0 ? "✓" : "•"} ${c.name}`);
}

// ------------------------------------------------------------------- fuzz ---
console.log(`\nFuzzing ${CASES} random resistor-ladder decks (seed ${getArg("--seed", 1)}):`);
const VALUES = ["100", "220", "470", "1k", "2.2k", "4.7k", "10k", "100k"];
let fuzzPass = 0;
for (let n = 0; n < CASES; n++) {
  const rungs = 2 + Math.floor(rand() * 5); // 2..6 resistors
  const lines = [`* fuzz deck ${n}`, `V1 n0 0 DC ${1 + Math.floor(rand() * 12)}`];
  for (let r = 0; r < rungs; r++) lines.push(`R${r + 1} n${r} n${r + 1} ${pick(VALUES)}`);
  lines.push(`R${rungs + 1} n${rungs} 0 ${pick(VALUES)}`, ".end");
  const deck = lines.join("\n");

  const ctx = `fuzz#${n}`;
  const res = importSpiceNetlist(deck);
  if (res.dropped.length !== 0) { fail(ctx, `dropped ${res.dropped.length} pure R/V line(s): ${res.dropped.map((d) => d.line).join("; ")}`); continue; }
  if (hasErrors(validate(res.airXml))) { fail(ctx, "imported deck failed validation"); continue; }
  checkKicad(ctx, parse(res.airXml));
  if (failures === 0) fuzzPass++;
  else break; // stop at first fuzz failure so the seed reproduces it
}
if (failures === 0) console.log(`  ✓ ${fuzzPass}/${CASES} decks imported+validated+exported clean`);

console.log(
  failures === 0
    ? "\nInterop round-trip gate: PASSED."
    : `\nInterop round-trip gate: FAILED (${failures} issue(s)).`,
);
process.exit(failures === 0 ? 0 : 1);
