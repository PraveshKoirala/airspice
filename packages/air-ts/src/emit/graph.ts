/**
 * Port of `packages/core/src/air/graph.py` (`build_graph_data` + the graph
 * compiler's serialization). Emits the schematic-graph JSON the UI's Schematic
 * tab renders: component nodes (with pin metadata), net nodes (with role), and
 * one edge per connected pin (with `sourceHandle`/`targetHandle` ids and per-
 * edge pin/net data).
 *
 * PARITY (byte-exact against tests/golden_corpus/<design>/graph.json):
 *   - The oracle writes graph.json with `json.dumps(obj, indent=2,
 *     sort_keys=True) + "\n"` (export_golden.py::_dumps). Our `dumps` (json.ts)
 *     reproduces that byte-for-byte, so `serializeGraph` just builds the same
 *     object graph and hands it to `dumps`. OBJECT KEY order is therefore
 *     irrelevant (dumps sorts every object/Map key by code point); ARRAY order
 *     is load-bearing and reproduced here exactly.
 *
 * ARRAY ORDER (json.dumps does NOT reorder lists):
 *   - `nodes`  : components first, sorted by id (code point); then net nodes,
 *                sorted by net id (code point).
 *   - `edges`  : grouped by component in the same id-sorted order, and WITHIN a
 *                component in DOCUMENT (pin insertion) order -- the oracle
 *                iterates `component.pins.values()`, not a sorted copy. Our model
 *                stores pins in an insertion-ordered Map, so `pins.values()`
 *                mirrors it. (Contrast: the per-node `pins` array IS sorted by
 *                pin name, exactly like the oracle's `sorted(..., key=p.name)`.)
 *
 * NET ROLE: taken verbatim from the parsed `net.role`. For a pin that references
 * a net NOT declared in `<nets>` (absent from `ir.nets`), the oracle synthesizes
 * an implicit net node whose role is INFERRED from the id and which carries
 * `implicit: true`; `inferNetRole` reproduces that fallback. (No golden-corpus
 * design exercises the implicit path -- every pin net is declared -- but it is
 * ported faithfully and covered by the emitter mutation test.)
 *
 * Zero DOM/fs dependency (epic #6): pure model -> JSON value. The UI worker
 * wraps this; this module never touches the DOM.
 */

import type { SystemIR, Net } from "../model.js";
import { type JsonValue, dumps } from "../json.js";

/** The graph payload the UI renders: `{ nodes, edges }`. */
export interface GraphData {
  nodes: JsonValue[];
  edges: JsonValue[];
}

/** Code-point (Python `sorted`) comparator for BMP strings. */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Build the schematic-graph data object (mirror of `build_graph_data(ir)`).
 *
 * Returns plain JSON values; serialization/ordering of OBJECT keys is deferred
 * to `dumps`. Array element order is fixed here to match the oracle.
 */
export function buildGraphData(ir: SystemIR): GraphData {
  const nodes: JsonValue[] = [];
  const edges: JsonValue[] = [];

  // `net_ids = set(ir.nets)` -- declared net ids, plus every net referenced by a
  // connected pin (added below). A Set preserves membership; ordering is applied
  // when we emit the net nodes (sorted).
  const netIds = new Set<string>(ir.nets.keys());

  // Components in id-sorted order (oracle: sorted(ir.components.values(), key=c.id)).
  const componentIds = [...ir.components.keys()].sort(byCodePoint);
  for (const cid of componentIds) {
    const component = ir.components.get(cid);
    if (component === undefined) continue;

    // Node `pins` array: sorted by pin name (oracle: sorted(..., key=p.name)).
    const pinNamesSorted = [...component.pins.keys()].sort(byCodePoint);
    const pins: JsonValue[] = [];
    for (const pinName of pinNamesSorted) {
      const pin = component.pins.get(pinName);
      if (pin === undefined) continue;
      pins.push({
        name: pin.name,
        net: pin.net,
        // `pin.function or ""` -- null/empty collapse to "".
        function: pin.function ?? "",
      });
    }

    nodes.push({
      id: component.id,
      type: "component",
      data: {
        label: component.id,
        type: component.type,
        // Each of these mirrors the oracle's `X or ""` (None/empty -> "").
        part: component.part ?? "",
        value: component.value ?? "",
        spice_model: component.spice_model ?? "",
        pins,
      },
    });

    // Edges: iterate pins in DOCUMENT order (oracle: component.pins.values()),
    // one edge per pin that has a net.
    for (const pin of component.pins.values()) {
      if (!pin.net) continue;
      netIds.add(pin.net);
      const netNode = `net:${pin.net}`;
      edges.push({
        id: `${component.id}:${pin.name}->${pin.net}`,
        source: component.id,
        target: netNode,
        sourceHandle: `pin:${pin.name}`,
        targetHandle: "net",
        label: pin.name,
        data: { pin: pin.name, net: pin.net },
      });
    }
  }

  // Net nodes in id-sorted order (oracle: for net_id in sorted(net_ids)).
  for (const netId of [...netIds].sort(byCodePoint)) {
    const net = ir.nets.get(netId);
    const role = net !== undefined ? net.role : inferNetRole(netId);
    const data: Record<string, JsonValue> = { label: netId, role };
    if (net === undefined) {
      // Implicit net (referenced by a pin but not declared): flagged so the UI
      // and future exports can distinguish it. (No corpus design hits this.)
      data["implicit"] = true;
    }
    nodes.push({ id: `net:${netId}`, type: "net", data });
  }

  return { nodes, edges };
}

/**
 * Port of `_infer_net_role`: the fallback role for an IMPLICIT net (one not
 * declared in `<nets>`). Verbatim id sets and lower-casing from the oracle.
 */
export function inferNetRole(netId: string): string {
  const normalized = netId.toLowerCase();
  if (GROUND_IDS.has(normalized)) return "ground";
  if (POWER_IDS.has(normalized)) return "power";
  return "signal";
}

const GROUND_IDS = new Set<string>(["gnd", "ground", "0", "vss"]);
const POWER_IDS = new Set<string>([
  "vcc",
  "vdd",
  "vin",
  "bat",
  "battery",
  "3v3",
  "5v",
  "+3v3",
  "+5v",
]);

/**
 * Serialize the schematic graph to the byte-exact `graph.json` string (trailing
 * newline included), matching the golden-corpus fixture.
 */
export function serializeGraph(ir: SystemIR): string {
  const { nodes, edges } = buildGraphData(ir);
  // The oracle returns `{"nodes": ..., "edges": ...}`; `dumps` sorts top-level
  // keys, so the emitted order is `edges` then `nodes` regardless of the object
  // literal order here -- matching the fixture (edges block precedes nodes).
  return dumps({ nodes, edges } as unknown as JsonValue);
}

// Re-export the Net type so downstream (UI facade) can reason about roles.
export type { Net };
