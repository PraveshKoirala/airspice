/**
 * Schematic auto-layout (issue #22 refactor).
 *
 * Extracted verbatim from the pre-refactor Graph.tsx: ELK-driven placement,
 * grid snapping, rail band computation, and the de-overlap pass. This is the
 * behavior contract of the entire schematic tab. PARITY is verified by
 * scripts/schematic-parity: given the same {nodes, edges}, the SchematicIR
 * this module produces is byte-identical (to 3 decimal places on positions)
 * to the monolith. Move a line, break parity.
 *
 * The only public entry is `buildSchematic(nodes, edges, hints?)`. `hints`
 * is a per-component override map (issue #22 B): when a component's id is
 * present, we skip ELK for that node and pin its centre at the hinted
 * coordinates (grid-snapped). Un-hinted components fall through to ELK, so
 * mixing hinted and un-hinted components in one design is fine.
 */

import type { Edge, Node } from "reactflow";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode, ElkExtendedEdge } from "elkjs/lib/elk-api";
import type {
  GuiHint,
  NetRole,
  NetShape,
  Orientation,
  Pin,
  PinPoint,
  Point,
  SchematicComponent,
  SchematicIR,
} from "./types";

const elk = new ELK();

const POWER_Y = 92;
const GROUND_Y = 620;

// Placement lattice. Component centres are snapped to this pitch so every
// symbol lands on the drawn background grid, which is what reads as "crisp".
export const GRID = 24;
export const snap = (value: number) => Math.round(value / GRID) * GRID;

// Vertical band reserved above the components for power rails and below for the
// ground rail; signal nets are routed within the component band itself.
const RAIL_GAP = 48;
const POWER_LANE_STEP = 34;
const MARGIN_X = 130;

function pinsOf(node: Node): Pin[] {
  return (Array.isArray(node.data?.pins) ? node.data.pins : []) as Pin[];
}

export function roleOf(rawRole: unknown): NetRole {
  const role = String(rawRole || "signal").toLowerCase();
  if (role === "power") return "power";
  if (role === "ground") return "ground";
  return "signal";
}

export function normalizedPin(pin: string): string {
  const upper = pin.toUpperCase();
  if (upper === "P" || upper === "POS" || upper === "PLUS") return "+";
  if (upper === "N" || upper === "NEG" || upper === "MINUS") return "-";
  return upper;
}

function primaryPowerNet(netRoles: Map<string, NetRole>): string {
  const powers = [...netRoles.entries()].filter(([, role]) => role === "power").map(([net]) => net);
  return powers.find((net) => /vcc|vdd|vin|bat|\+/.test(net.toLowerCase())) || powers[0] || "vcc";
}

function toSchematicComponent(node: Node, x: number, y: number, orientation: Orientation): SchematicComponent {
  return {
    id: String(node.id),
    type: String(node.data?.type || "component").toLowerCase(),
    value: String(node.data?.value || ""),
    part: String(node.data?.part || ""),
    spiceModel: String(node.data?.spice_model || ""),
    x,
    y,
    orientation,
    pins: pinsOf(node),
  };
}

type LayoutResult = {
  components: SchematicComponent[];
  width: number;
  height: number;
  powerBaseY: number;
  groundY: number;
};

function portId(component: string, pin: string): string {
  return `${component}::${pin}`;
}

/**
 * Place components with the Eclipse Layout Kernel (ELK), unless the caller
 * supplied `<gui>` hints for them (issue #22 B): hinted components are pinned
 * to their (x,y) centre and skipped during ELK entirely, while un-hinted
 * components still go through the auto-router. This keeps the "layout is a
 * fallback chain" contract in the epic #21 binding decision -- hints win,
 * ELK fills in.
 *
 * Each un-hinted component becomes an ELK node whose ports sit exactly where
 * the symbol's pins are drawn ({@link pinOffset}), so ELK spaces and orders
 * components by their true terminal sides. Only *signal* nets are handed to
 * ELK (as small hub nodes that every pin on the net connects to) -- power
 * and ground are drawn as rails afterwards, so routing them here would
 * collapse the left-to-right signal flow. ELK's own edge routes are
 * discarded; we keep only the node positions and feed them, grid-snapped,
 * into the existing wire renderer.
 */
async function layoutComponents(
  nodes: Node[],
  netRoles: Map<string, NetRole>,
  hintsById: Map<string, GuiHint>,
): Promise<LayoutResult> {
  const components = nodes.filter((node) => node.type === "component");
  if (components.length === 0) {
    return { components: [], width: 960, height: 540, powerBaseY: POWER_Y, groundY: GROUND_Y };
  }

  const orientationById = new Map<string, Orientation>();
  const boxById = new Map<string, { width: number; height: number }>();

  // Split: components with a <gui> hint bypass ELK entirely.
  const unhintedElk: Node[] = [];
  const hintedCentres = new Map<string, { x: number; y: number }>();

  for (const node of components) {
    const type = String(node.data?.type || "component").toLowerCase();
    const orientation = orientationFor(type);
    const pins = pinsOf(node);
    const box = componentBox(type, orientation, pins);
    orientationById.set(node.id, orientation);
    boxById.set(node.id, box);

    const hint = hintsById.get(node.id);
    if (hint) {
      hintedCentres.set(node.id, { x: snap(hint.x), y: snap(hint.y) });
    } else {
      unhintedElk.push(node);
    }
  }

  const elkNodes: ElkNode[] = unhintedElk.map((node) => {
    const type = String(node.data?.type || "component").toLowerCase();
    const orientation = orientationById.get(node.id)!;
    const pins = pinsOf(node);
    const box = boxById.get(node.id)!;

    const ports = pins.map((pin) => {
      const offset = pinOffset(type, orientation, pins, pin);
      return {
        id: portId(node.id, pin.name),
        x: box.width / 2 + offset.x,
        y: box.height / 2 + offset.y,
        width: 1,
        height: 1,
      };
    });

    // Anchor sources at the left and MCUs/sensors at the right so the layout
    // reads as left-to-right signal flow.
    const layoutOptions: Record<string, string> = { "org.eclipse.elk.portConstraints": "FIXED_POS" };
    if (type === "voltage_source" || type === "current_source" || type === "battery") {
      layoutOptions["org.eclipse.elk.layered.layering.layerConstraint"] = "FIRST";
    } else if (type === "mcu" || type === "sensor") {
      layoutOptions["org.eclipse.elk.layered.layering.layerConstraint"] = "LAST";
    }

    return {
      id: node.id,
      width: box.width,
      height: box.height,
      ports,
      layoutOptions,
    };
  });

  const pinsByNet = new Map<string, { component: string; pin: string }[]>();
  components.forEach((node) => {
    pinsOf(node).forEach((pin) => {
      if (!pin.net) return;
      const list = pinsByNet.get(pin.net) || [];
      list.push({ component: node.id, pin: pin.name });
      pinsByNet.set(pin.net, list);
    });
  });

  const signalHubs: ElkNode[] = [];
  const elkEdges: ElkExtendedEdge[] = [];
  pinsByNet.forEach((pins, net) => {
    if ((netRoles.get(net) || "signal") !== "signal") return;
    if (pins.length < 2) return;
    const hubId = `hub:${net}`;
    signalHubs.push({ id: hubId, width: 8, height: 8 });
    pins.forEach((entry, index) => {
      // Skip edges out of hinted components (they aren't in the ELK graph).
      if (hintedCentres.has(entry.component)) return;
      elkEdges.push({
        id: `e:${net}:${index}`,
        sources: [portId(entry.component, entry.pin)],
        targets: [hubId],
      });
    });
  });

  const positioned = new Map<string, { x: number; y: number }>();
  if (elkNodes.length > 0) {
    const graph: ElkNode = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "55",
        "elk.layered.spacing.nodeNodeBetweenLayers": "95",
        "elk.spacing.portPort": "22",
        "elk.layered.spacing.edgeNodeBetweenLayers": "30",
        "elk.separateConnectedComponents": "true",
      },
      children: [...elkNodes, ...signalHubs],
      edges: elkEdges,
    };

    const laid = await elk.layout(graph);
    (laid.children || []).forEach((child) => {
      if (typeof child.x === "number" && typeof child.y === "number") {
        positioned.set(child.id, { x: child.x, y: child.y });
      }
    });
  }

  // Hinted centres are already grid-snapped and are used AS-IS. Un-hinted
  // components get ELK top-left -> grid-snapped centre. If there are no
  // un-hinted components at all, we skip the shift-into-margin pass so
  // hinted designs render at their exact stored coordinates.
  const unhintedCentres = unhintedElk.map((node) => {
    const box = boxById.get(node.id)!;
    const pos = positioned.get(node.id) || { x: 0, y: 0 };
    return { id: node.id, x: snap(pos.x + box.width / 2), y: snap(pos.y + box.height / 2) };
  });

  // Shift the drawing into left/top margins, leaving room for the power rails.
  // Only applied to the un-hinted flow so a design fully covered by hints
  // renders at its exact stored coordinates.
  const powerNetCount = [...netRoles.values()].filter((role) => role === "power").length;
  const lanes = Math.max(1, powerNetCount);
  const topBand = RAIL_GAP + lanes * POWER_LANE_STEP;

  let shiftedUnhinted = unhintedCentres;
  if (unhintedCentres.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    unhintedCentres.forEach((centre) => {
      const box = boxById.get(centre.id)!;
      minX = Math.min(minX, centre.x - box.width / 2);
      minY = Math.min(minY, centre.y - box.height / 2);
    });
    const tx = snap(MARGIN_X - minX);
    const ty = snap(topBand - minY);
    shiftedUnhinted = unhintedCentres.map((centre) => ({ id: centre.id, x: centre.x + tx, y: centre.y + ty }));
  }

  // Merge: hinted centres (as-is) + shifted un-hinted centres.
  let centres = [
    ...[...hintedCentres.entries()].map(([id, c]) => ({ id, x: c.x, y: c.y })),
    ...shiftedUnhinted,
  ];

  // De-overlap pass: keep wires from running through symbols. Runs on
  // UN-HINTED components only -- a component the user pinned with <gui>
  // stays where they put it, even if it now collides with a shunt path.
  //
  // ELK packs every member of a net into a single column, which stacks parallel
  // shunt branches collinearly -- e.g. a divider's lower resistor and a
  // decoupling cap (both signal->gnd) end up in one column, so each one's stub
  // crosses the other's body. We can't tell the divider's series leg from the
  // shunt cap by net role (both are signal+gnd); the giveaway is geometric, so
  // we detect a stub that traverses another symbol and fan the lower component
  // out into its own column, lifted so its signal pin sits just under the trunk.
  const meta = new Map(
    components.map((node) => [
      node.id,
      {
        type: String(node.data?.type || "component").toLowerCase(),
        orientation: orientationById.get(node.id)!,
        pins: pinsOf(node),
      },
    ]),
  );
  const centreById = new Map(centres.map((centre) => [centre.id, centre]));
  const GROUND_SENTINEL = 1e6;
  const POWER_SENTINEL = -1e6;
  const COL_STEP = 144;

  const pinAbs = (id: string, pin: Pin): Point => {
    const m = meta.get(id)!;
    const centre = centreById.get(id)!;
    const offset = pinOffset(m.type, m.orientation, m.pins, pin);
    return { x: centre.x + offset.x, y: centre.y + offset.y };
  };
  // Trunk Y of a signal net = median of its pin Ys (matches the wire renderer).
  const trunkYOf = (net: string): number => {
    const ys: number[] = [];
    meta.forEach((m, id) =>
      m.pins.forEach((pin) => {
        if (pin.net === net) ys.push(pinAbs(id, pin).y);
      }),
    );
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length / 2)] || 0;
  };
  const targetY = (net: string): number => {
    const role = netRoles.get(net) || "signal";
    if (role === "ground") return GROUND_SENTINEL;
    if (role === "power") return POWER_SENTINEL;
    return trunkYOf(net);
  };
  // Obstacle extent = the symbol's pin-to-pin span (no padding), so a stub that
  // merely meets another component at a shared trunk node is not a crossing.
  const coreSpan = (id: string): { top: number; bottom: number } | null => {
    const m = meta.get(id)!;
    if (m.pins.length === 0) return null;
    const ys = m.pins.map((pin) => pinAbs(id, pin).y);
    return { top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  const occupied = (x: number, top: number, bottom: number, skip: string): boolean =>
    [...centreById.values()].some((centre) => {
      if (centre.id === skip || centre.x !== x) return false;
      const box = boxById.get(centre.id)!;
      return !(centre.y + box.height / 2 < top || centre.y - box.height / 2 > bottom);
    });

  for (let iter = 0; iter < components.length * 2; iter++) {
    let moved = false;
    const ordered = [...centreById.values()].sort((a, b) => b.y - a.y);
    for (const b of ordered) {
      for (const pin of meta.get(b.id)!.pins) {
        const start = pinAbs(b.id, pin);
        const finish = targetY(pin.net);
        const top = Math.min(start.y, finish);
        const bottom = Math.max(start.y, finish);
        const blocker = ordered.find((a) => {
          if (a.id === b.id || a.x !== b.x) return false;
          const span = coreSpan(a.id);
          return span !== null && span.bottom > top && span.top < bottom;
        });
        if (!blocker) continue;
        // Fan the lower of the two out into a free column. Skip the move if
        // the target is a hinted component -- respect the user's placement.
        const mover = blocker.y > b.y ? blocker : b;
        if (hintedCentres.has(mover.id)) continue;
        const mm = meta.get(mover.id)!;
        const moverBox = boxById.get(mover.id)!;
        const signalPin = mm.pins.find((candidate) => (netRoles.get(candidate.net) || "signal") === "signal");
        let ny = mover.y;
        if (signalPin) {
          const offset = pinOffset(mm.type, mm.orientation, mm.pins, signalPin);
          ny = snap(trunkYOf(signalPin.net) - offset.y);
        }
        let nx = mover.x + COL_STEP;
        while (occupied(nx, ny - moverBox.height / 2, ny + moverBox.height / 2, mover.id)) nx += COL_STEP;
        centreById.set(mover.id, { id: mover.id, x: snap(nx), y: ny });
        moved = true;
        break;
      }
      if (moved) break;
    }
    if (!moved) break;
  }
  centres = [...centreById.values()];

  let maxX = 0;
  let maxBottom = 0;
  let minTop = Infinity;
  centres.forEach((centre) => {
    const box = boxById.get(centre.id)!;
    maxX = Math.max(maxX, centre.x + box.width / 2);
    maxBottom = Math.max(maxBottom, centre.y + box.height / 2);
    minTop = Math.min(minTop, centre.y - box.height / 2);
  });

  const byId = new Map(components.map((node) => [node.id, node]));
  const placed = centres.map((centre) =>
    toSchematicComponent(byId.get(centre.id)!, centre.x, centre.y, orientationById.get(centre.id)!),
  );

  return {
    components: placed,
    width: maxX + MARGIN_X,
    height: maxBottom + RAIL_GAP + 40,
    powerBaseY: snap(Math.max(GRID, minTop - RAIL_GAP - (lanes - 1) * POWER_LANE_STEP)),
    groundY: snap(maxBottom + RAIL_GAP),
  };
}

/**
 * Pin location relative to the component centre. This is the single source of
 * truth for terminal geometry: it feeds both the ELK ports (so the layout
 * engine spaces components by their real pin sides) and the rendered pin
 * markers / wire endpoints (so wires meet symbols exactly).
 */
export function pinOffset(
  type: string,
  orientation: Orientation,
  pins: Pin[],
  pin: Pin,
): Point {
  const pinName = normalizedPin(pin.name);

  if (type === "bjt") {
    if (pinName === "B") return { x: -58, y: 0 };
    if (pinName === "C") return { x: 38, y: -86 };
    if (pinName === "E") return { x: 38, y: 86 };
  }
  if (type === "mosfet") {
    if (pinName === "G") return { x: -62, y: 0 };
    if (pinName === "D") return { x: 38, y: -86 };
    if (pinName === "S") return { x: 38, y: 86 };
  }
  if (type === "ldo") {
    if (pinName === "IN") return { x: -90, y: -18 };
    if (pinName === "OUT") return { x: 90, y: -18 };
    if (pinName === "GND") return { x: 0, y: 80 };
  }
  if (type === "mcu" || type === "sensor") {
    if (pinName.includes("GND")) return { x: -20, y: 88 };
    if (pinName.includes("3V") || pinName.includes("VCC") || pinName.includes("VDD")) return { x: -20, y: -88 };
    if (pin.function?.includes("ADC") || pinName.includes("GPIO4")) return { x: -92, y: -8 };
    const index = pins.findIndex((candidate) => candidate.name === pin.name);
    return { x: 92, y: -34 + index * 20 };
  }
  if (type === "voltage_source" || type === "current_source" || type === "battery") {
    if (pinName === "+" || pinName === "1") return { x: 0, y: -74 };
    if (pinName === "-" || pinName === "2") return { x: 0, y: 74 };
  }

  if (orientation === "vertical") {
    if (pinName === "1" || pinName === "A" || pinName === "+") return { x: 0, y: -68 };
    return { x: 0, y: 68 };
  }
  if (pinName === "1" || pinName === "A" || pinName === "+") return { x: -76, y: 0 };
  return { x: 76, y: 0 };
}

export function pinPoint(component: SchematicComponent, pin: Pin): PinPoint {
  const offset = pinOffset(component.type, component.orientation, component.pins, pin);
  return {
    component: component.id,
    pin: pin.name,
    net: pin.net,
    x: component.x + offset.x,
    y: component.y + offset.y,
  };
}

export function orientationFor(type: string): Orientation {
  return type === "mcu" || type === "sensor" || type === "ldo" ? "horizontal" : "vertical";
}

/**
 * Axis-aligned bounding box of a component, derived from its pin extents so
 * ELK reserves enough space around each symbol (including its leads).
 */
export function componentBox(type: string, orientation: Orientation, pins: Pin[]): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  pins.forEach((pin) => {
    const offset = pinOffset(type, orientation, pins, pin);
    maxX = Math.max(maxX, Math.abs(offset.x));
    maxY = Math.max(maxY, Math.abs(offset.y));
  });
  const PAD = 28;
  return {
    width: Math.max(120, maxX * 2 + PAD),
    height: Math.max(120, maxY * 2 + PAD),
  };
}

/**
 * Build the SchematicIR (positions + wire routes + labels) from the graph
 * nodes/edges the engine facade produced. `hints`, when non-empty, pins the
 * listed components to their (x,y) coordinates and skips ELK for them
 * (issue #22 B: <gui> hints are the source of truth when present).
 */
export async function buildSchematic(
  nodes: Node[],
  edges: Edge[],
  hints: GuiHint[] = [],
): Promise<SchematicIR> {
  const netRoles = new Map<string, NetRole>();
  nodes
    .filter((node) => node.type === "net")
    .forEach((node) => {
      netRoles.set(String(node.data?.label || String(node.id).replace(/^net:/, "")), roleOf(node.data?.role));
    });

  edges.forEach((edge) => {
    const net = String(edge.data?.net || String(edge.target).replace(/^net:/, ""));
    if (!netRoles.has(net)) netRoles.set(net, "signal");
  });

  const hintsById = new Map(hints.map((h) => [h.componentId, h]));
  const layout = await layoutComponents(nodes, netRoles, hintsById);
  const components = layout.components;
  const pointsByNet = new Map<string, PinPoint[]>();
  components.forEach((component) => {
    component.pins.forEach((pin) => {
      const point = pinPoint(component, pin);
      const points = pointsByNet.get(pin.net) || [];
      points.push(point);
      pointsByNet.set(pin.net, points);
    });
  });

  const powerNet = primaryPowerNet(netRoles);
  const powerLane = new Map<string, number>();
  const powerNets = [...pointsByNet.keys()]
    .filter((net) => (netRoles.get(net) || "signal") === "power")
    .sort((a, b) => {
      if (a === powerNet) return -1;
      if (b === powerNet) return 1;
      return a.localeCompare(b);
    });
  powerNets.forEach((net, index) => powerLane.set(net, snap(layout.powerBaseY + index * POWER_LANE_STEP)));

  // Horizontal x-spans occupied by component symbols, used to drop each signal
  // net's label into the widest open stretch of its trunk instead of a fixed
  // offset that can land on a part.
  const spans = components.map((component) => {
    const box = componentBox(component.type, component.orientation, component.pins);
    return { left: component.x - box.width / 2, right: component.x + box.width / 2 };
  });

  // Side-labelled vertical passives default to the left (text-anchor: end); flip
  // them to whichever side has clearance so the ref/value don't run into a
  // neighbour symbol.
  const isVerticalPassive = (component: SchematicComponent) =>
    ["resistor", "capacitor", "diode", "generic_load"].includes(component.type) && component.orientation === "vertical";
  const LABEL_REACH = 66;
  components.forEach((component) => {
    if (!isVerticalPassive(component)) return;
    const half = componentBox(component.type, component.orientation, component.pins).height / 2;
    let leftGap = Infinity;
    let rightGap = Infinity;
    components.forEach((other) => {
      if (other.id === component.id) return;
      const otherBox = componentBox(other.type, other.orientation, other.pins);
      if (Math.abs(other.y - component.y) >= half + otherBox.height / 2) return; // symbols don't share a row
      if (other.x < component.x) leftGap = Math.min(leftGap, component.x - LABEL_REACH - (other.x + otherBox.width / 2));
      else rightGap = Math.min(rightGap, other.x - otherBox.width / 2 - (component.x + LABEL_REACH));
    });
    const leftOk = leftGap >= LABEL_REACH;
    const rightOk = rightGap >= LABEL_REACH;
    component.labelSide = !leftOk && rightOk ? "right" : leftOk && !rightOk ? "left" : rightGap > leftGap ? "right" : "left";
  });
  const signalLabelX = (points: PinPoint[]): number => {
    const xs = points.map((point) => point.x);
    const lo = Math.min(...xs) - 36;
    const hi = Math.max(...xs) + 36;
    const blocks = spans.filter((s) => s.right > lo && s.left < hi).sort((a, b) => a.left - b.left);
    const gaps: { start: number; end: number }[] = [];
    let cursor = lo;
    blocks.forEach((block) => {
      if (block.left > cursor) gaps.push({ start: cursor, end: block.left });
      cursor = Math.max(cursor, block.right);
    });
    if (cursor < hi) gaps.push({ start: cursor, end: hi });
    const widest = gaps.sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (!widest || widest.end - widest.start < 56) return lo + 132;
    return snap((widest.start + widest.end) / 2 - 28);
  };

  const nets: NetShape[] = [...pointsByNet.entries()].map(([net, points]) => {
    const role = netRoles.get(net) || "signal";
    return {
      id: net,
      role,
      label: net,
      laneY: role === "power" ? powerLane.get(net) : role === "ground" ? layout.groundY : undefined,
      labelX: role === "signal" && points.length > 1 ? signalLabelX(points) : undefined,
      points,
    };
  });

  return { components, nets, width: layout.width, height: layout.height };
}

// --- helpers used by symbol/wire rendering (re-exported for symbols.tsx) ---

export function segmentPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

export const POWER_Y_CONST = POWER_Y;
export const GROUND_Y_CONST = GROUND_Y;
