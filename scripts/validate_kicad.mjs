/**
 * KiCad export validation against real kicad-cli (Milestone M7, issue #34).
 *
 * Generates a .kicad_sch with the air-ts exporter, runs
 * `kicad-cli sch export netlist`, and asserts the extracted netlist connectivity
 * matches the source AIR design — the machine proof that the exported schematic
 * both opens (no missing symbols) and NETS correctly in KiCad.
 *
 * Graceful skip (exit 0) when kicad-cli is not installed, so it is safe to run
 * anywhere; exit 1 only on a real connectivity mismatch. Requires a prior
 * `npm run build:air-ts`.
 */
import { parse, exportKicad } from "../packages/air-ts/dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

function findKicadCli() {
  for (const cand of ["kicad-cli", "kicad-cli.exe"]) {
    try { execFileSync(cand, ["version"], { stdio: "ignore" }); return cand; } catch { /* not on PATH */ }
  }
  const local = (process.env.LOCALAPPDATA || "").replace(/\\/g, "/");
  const patterns = [
    "C:/Program Files/KiCad/*/bin/kicad-cli.exe",
    "C:/Program Files (x86)/KiCad/*/bin/kicad-cli.exe",
    local && `${local}/Programs/KiCad/*/bin/kicad-cli.exe`,
    "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
    "/usr/bin/kicad-cli",
    "/usr/local/bin/kicad-cli",
  ].filter(Boolean);
  for (const p of patterns) {
    const hits = globSync(p);
    if (hits && hits.length) return hits[0];
  }
  return null;
}

const DESIGNS = [
  {
    name: "divider",
    xml: `<system name="divider" ir_version="0.1"><metadata><title>Divider</title></metadata>
<nets><net id="gnd" role="ground"/><net id="vcc" role="power"/><net id="mid" role="signal"/></nets>
<components>
<component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="vcc"/><pin name="n" net="gnd"/></component>
<component id="R1" type="resistor"><value>10k</value><pin name="1" net="vcc"/><pin name="2" net="mid"/></component>
<component id="R2" type="resistor"><value>10k</value><pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
</components></system>`,
  },
  {
    name: "npn-switch",
    xml: `<system name="npn" ir_version="0.1"><metadata><title>NPN</title></metadata>
<nets><net id="gnd" role="ground"/><net id="vcc" role="power"/><net id="base" role="signal"/><net id="coll" role="signal"/></nets>
<components>
<component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="vcc"/><pin name="n" net="gnd"/></component>
<component id="Rb" type="resistor"><value>4.7k</value><pin name="1" net="vcc"/><pin name="2" net="base"/></component>
<component id="Rc" type="resistor"><value>1k</value><pin name="1" net="vcc"/><pin name="2" net="coll"/></component>
<component id="Q1" type="bjt"><pin name="C" net="coll"/><pin name="B" net="base"/><pin name="E" net="gnd"/></component>
</components></system>`,
  },
];

const cli = findKicadCli();
if (!cli) {
  console.log("SKIP: kicad-cli not found (install KiCad to run this validation).");
  process.exit(0);
}
console.log("kicad-cli:", cli, "\n");

const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
let failures = 0;

for (const design of DESIGNS) {
  const ir = parse(design.xml);
  const res = exportKicad(ir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kicadval-"));
  const schPath = path.join(dir, "design.kicad_sch");
  const netPath = path.join(dir, "design.net.xml");
  fs.writeFileSync(schPath, res.text);

  const expected = {};
  for (const c of ir.components.values())
    for (const p of c.pins.values()) (expected[p.net] ??= new Set()).add(`${c.id}.${p.name}`);

  let out;
  try {
    execFileSync(cli, ["sch", "export", "netlist", "--format", "kicadxml", "--output", netPath, schPath], { stdio: "pipe" });
    out = fs.readFileSync(netPath, "utf8");
  } catch (e) {
    console.error(`  ✗ [${design.name}] kicad-cli failed: ${e.stderr ? e.stderr.toString() : e.message}`);
    failures++;
    continue;
  }

  const actual = [];
  for (const netBlock of out.matchAll(/<net\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) {
    const nodes = new Set();
    for (const node of netBlock[2].matchAll(/<node\b[^>]*\bref="([^"]*)"[^>]*\bpin="([^"]*)"/g))
      nodes.add(`${node[1]}.${node[2]}`);
    actual.push(nodes);
  }

  let ok = res.symbols === ir.components.size;
  if (!ok) console.error(`  ✗ [${design.name}] symbol count ${res.symbols} != ${ir.components.size}`);
  for (const [net, pins] of Object.entries(expected)) {
    if (!actual.some((s) => setsEqual(s, pins))) {
      ok = false;
      console.error(`  ✗ [${design.name}] net '${net}' {${[...pins].sort().join(", ")}} not reproduced by kicad-cli`);
    }
  }
  if (ok) console.log(`  ✓ ${design.name}: ${Object.keys(expected).length} nets + ${ir.components.size} symbols confirmed by kicad-cli`);
  else failures++;
}

console.log(failures === 0 ? "\nKiCad export validated by kicad-cli: PASSED." : `\nKiCad export validation: FAILED (${failures}).`);
process.exit(failures === 0 ? 0 : 1);
