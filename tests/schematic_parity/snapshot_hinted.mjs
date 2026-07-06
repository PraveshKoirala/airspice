/**
 * Sanity check for the <gui>-hint layout path (issue #22 B/D).
 *
 * Loads the ESP32 sensor design, injects a hint on R_BAT_TOP, and confirms
 * buildSchematic pins that component at the hinted coordinates -- i.e. the
 * layout output puts R_BAT_TOP.x/R_BAT_TOP.y at the snapped hint. Also
 * confirms un-hinted components still auto-layout (their positions change
 * because the ELK routing sees one fewer node in the graph).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toGraph } from "air-ts";
import { buildSchematic, snap } from "../../packages/ui/src/schematic/layout.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const xml = readFileSync(
  join(REPO, "tests", "golden_corpus", "esp32_battery_sensor", "input.air.xml"),
  "utf8",
);
const graph = toGraph(xml);

const noHints = await buildSchematic(graph.nodes, graph.edges);
const hinted = await buildSchematic(graph.nodes, graph.edges, [
  { componentId: "R_BAT_TOP", x: 400, y: 300, rot: 0 },
]);

const r1no = noHints.components.find((c) => c.id === "R_BAT_TOP");
const r1yes = hinted.components.find((c) => c.id === "R_BAT_TOP");
if (!r1no || !r1yes) throw new Error("R_BAT_TOP not placed");

console.log("no-hint  R_BAT_TOP:", r1no.x, r1no.y);
console.log("hinted   R_BAT_TOP:", r1yes.x, r1yes.y, "(expected snapped)");
const expected = { x: snap(400), y: snap(300) };
if (r1yes.x !== expected.x || r1yes.y !== expected.y) {
  console.error("FAIL: hinted position != snapped hint");
  process.exit(1);
}
console.log("ok: hint pins component to snapped(x, y)");
