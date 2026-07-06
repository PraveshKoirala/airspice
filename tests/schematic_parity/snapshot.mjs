/**
 * Refactor parity snapshot for issue #22.
 *
 * Loads three corpus designs, feeds each through air-ts to produce the
 * schematic-graph (`{nodes, edges}`), then invokes the UI's `buildSchematic`
 * to produce the `SchematicIR` (positions, wire routes, net roles). We
 * serialize the resulting IR deterministically -- sorted top-level keys,
 * arrays sorted by id where present -- so the pre-refactor bytes byte-match
 * the post-refactor bytes. If any component moves by even one pixel, the diff
 * will show it.
 *
 * Usage:
 *   npx tsx tests/schematic_parity/snapshot.mjs --write <out-dir>
 *   npx tsx tests/schematic_parity/snapshot.mjs --check <baseline-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, toGraph } from "air-ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const DESIGNS = [
  "esp32_battery_sensor",
  "mixed_signal_switch",
  "analog_primitives",
];

function loadDesign(name) {
  const path = join(REPO, "tests", "golden_corpus", name, "input.air.xml");
  return readFileSync(path, "utf8");
}

async function loadBuildSchematic() {
  // Post-refactor entry point (Graph.tsx is components-only per the
  // react-refresh/only-export-components lint rule; buildSchematic lives
  // in schematic/layout.ts). The pre-refactor fallback that used to sit
  // here was needed only to capture the BASELINE snapshot -- the
  // committed baseline JSON is that snapshot, so this loader now targets
  // the single extracted module.
  const mod = await import("../../packages/ui/src/schematic/layout.ts");
  return mod.buildSchematic;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function normalizeIr(ir) {
  // Round position floats to 4 decimals so tiny numeric jitter across module
  // graph rewrites (which shouldn't happen, but let's be robust) doesn't
  // introduce noise. Component ids ARE the identity so sort by id for stability.
  const components = [...ir.components]
    .map((c) => ({
      id: c.id,
      type: c.type,
      value: c.value,
      part: c.part,
      spiceModel: c.spiceModel,
      x: Math.round(c.x * 1000) / 1000,
      y: Math.round(c.y * 1000) / 1000,
      orientation: c.orientation,
      labelSide: c.labelSide ?? null,
      pins: c.pins.map((p) => ({ name: p.name, net: p.net, function: p.function ?? null })),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nets = [...ir.nets]
    .map((n) => ({
      id: n.id,
      role: n.role,
      label: n.label,
      laneY: n.laneY !== undefined ? Math.round(n.laneY * 1000) / 1000 : null,
      trunkY: n.trunkY !== undefined ? Math.round(n.trunkY * 1000) / 1000 : null,
      labelX: n.labelX !== undefined ? Math.round(n.labelX * 1000) / 1000 : null,
      points: [...n.points]
        .map((p) => ({
          component: p.component,
          pin: p.pin,
          net: p.net,
          x: Math.round(p.x * 1000) / 1000,
          y: Math.round(p.y * 1000) / 1000,
        }))
        .sort((a, b) => {
          if (a.component !== b.component) return a.component < b.component ? -1 : 1;
          return a.pin < b.pin ? -1 : a.pin > b.pin ? 1 : 0;
        }),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    width: Math.round(ir.width * 1000) / 1000,
    height: Math.round(ir.height * 1000) / 1000,
    components,
    nets,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const outDir = args[1];
  if (!mode || !outDir || !["--write", "--check"].includes(mode)) {
    console.error("usage: snapshot.mjs --write|--check <dir>");
    process.exit(2);
  }
  if (mode === "--write") mkdirSync(outDir, { recursive: true });

  const buildSchematic = await loadBuildSchematic();
  let anyMismatch = false;
  for (const name of DESIGNS) {
    const xml = loadDesign(name);
    parse(xml); // sanity parse
    const graph = toGraph(xml);
    const ir = await buildSchematic(graph.nodes, graph.edges);
    const bytes = stableStringify(normalizeIr(ir)) + "\n";
    const target = join(outDir, `${name}.json`);
    if (mode === "--write") {
      writeFileSync(target, bytes);
      console.log(`wrote ${target} (${bytes.length} bytes)`);
    } else {
      if (!existsSync(target)) {
        console.error(`missing baseline: ${target}`);
        anyMismatch = true;
        continue;
      }
      const baseline = readFileSync(target, "utf8");
      if (baseline !== bytes) {
        anyMismatch = true;
        console.error(`DIFF ${name}`);
        // Print a compact diff summary: show first mismatching byte index and
        // a small context window either side.
        let i = 0;
        while (i < baseline.length && i < bytes.length && baseline[i] === bytes[i]) i++;
        const ctx = 80;
        console.error(`  first diff at byte ${i}`);
        console.error(`  baseline: ${JSON.stringify(baseline.slice(Math.max(0, i - ctx), i + ctx))}`);
        console.error(`  current : ${JSON.stringify(bytes.slice(Math.max(0, i - ctx), i + ctx))}`);
      } else {
        console.log(`ok ${name} (${bytes.length} bytes)`);
      }
    }
  }
  if (mode === "--check" && anyMismatch) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
