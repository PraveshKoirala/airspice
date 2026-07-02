import React, { useEffect, useState } from 'react';
import type { Edge, Node } from 'reactflow';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api';

const elk = new ELK();

interface GraphProps {
  nodes: Node[];
  edges: Edge[];
}

type Pin = {
  name: string;
  net: string;
  function?: string;
};

type Point = {
  x: number;
  y: number;
};

type SchematicComponent = {
  id: string;
  type: string;
  value: string;
  part: string;
  spiceModel: string;
  x: number;
  y: number;
  orientation: 'horizontal' | 'vertical';
  labelSide?: 'left' | 'right';
  pins: Pin[];
};

type PinPoint = Point & {
  component: string;
  pin: string;
  net: string;
};

type NetShape = {
  id: string;
  role: 'power' | 'ground' | 'signal';
  label: string;
  laneY?: number;
  trunkY?: number;
  labelX?: number;
  points: PinPoint[];
};

type SchematicIR = {
  components: SchematicComponent[];
  nets: NetShape[];
  width: number;
  height: number;
};

const POWER_Y = 92;
const GROUND_Y = 620;
const SIGNAL_COLOR = '#0f766e';
const POWER_COLOR = '#b45309';
const GROUND_COLOR = '#475569';

// Placement lattice. Component centres are snapped to this pitch so every
// symbol lands on the drawn background grid, which is what reads as "crisp".
const GRID = 24;
const snap = (value: number) => Math.round(value / GRID) * GRID;

function pinsOf(node: Node): Pin[] {
  return (Array.isArray(node.data?.pins) ? node.data.pins : []) as Pin[];
}

function roleOf(rawRole: unknown): 'power' | 'ground' | 'signal' {
  const role = String(rawRole || 'signal').toLowerCase();
  if (role === 'power') return 'power';
  if (role === 'ground') return 'ground';
  return 'signal';
}

function normalizedPin(pin: string): string {
  const upper = pin.toUpperCase();
  if (upper === 'P' || upper === 'POS' || upper === 'PLUS') return '+';
  if (upper === 'N' || upper === 'NEG' || upper === 'MINUS') return '-';
  return upper;
}

function primaryPowerNet(netRoles: Map<string, 'power' | 'ground' | 'signal'>): string {
  const powers = [...netRoles.entries()].filter(([, role]) => role === 'power').map(([net]) => net);
  return powers.find((net) => /vcc|vdd|vin|bat|\+/.test(net.toLowerCase())) || powers[0] || 'vcc';
}

function toSchematicComponent(node: Node, x: number, y: number, orientation: 'horizontal' | 'vertical'): SchematicComponent {
  return {
    id: String(node.id),
    type: String(node.data?.type || 'component').toLowerCase(),
    value: String(node.data?.value || ''),
    part: String(node.data?.part || ''),
    spiceModel: String(node.data?.spice_model || ''),
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

// Vertical band reserved above the components for power rails and below for the
// ground rail; signal nets are routed within the component band itself.
const RAIL_GAP = 48;
const POWER_LANE_STEP = 34;
const MARGIN_X = 130;

function portId(component: string, pin: string): string {
  return `${component}::${pin}`;
}

/**
 * Place components with the Eclipse Layout Kernel (ELK).
 *
 * Each component becomes an ELK node whose ports sit exactly where the symbol's
 * pins are drawn ({@link pinOffset}), so ELK spaces and orders components by
 * their true terminal sides. Only *signal* nets are handed to ELK (as small hub
 * nodes that every pin on the net connects to) — power and ground are drawn as
 * rails afterwards, so routing them here would collapse the left-to-right
 * signal flow. ELK's own edge routes are discarded; we keep only the node
 * positions and feed them, grid-snapped, into the existing wire renderer.
 */
async function layoutComponents(
  nodes: Node[],
  netRoles: Map<string, 'power' | 'ground' | 'signal'>,
): Promise<LayoutResult> {
  const components = nodes.filter((node) => node.type === 'component');
  if (components.length === 0) {
    return { components: [], width: 960, height: 540, powerBaseY: POWER_Y, groundY: GROUND_Y };
  }

  const orientationById = new Map<string, 'horizontal' | 'vertical'>();
  const boxById = new Map<string, { width: number; height: number }>();

  const elkNodes: ElkNode[] = components.map((node) => {
    const type = String(node.data?.type || 'component').toLowerCase();
    const orientation = orientationFor(type);
    const pins = pinsOf(node);
    const box = componentBox(type, orientation, pins);
    orientationById.set(node.id, orientation);
    boxById.set(node.id, box);

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
    const layoutOptions: Record<string, string> = { 'org.eclipse.elk.portConstraints': 'FIXED_POS' };
    if (type === 'voltage_source' || type === 'current_source' || type === 'battery') {
      layoutOptions['org.eclipse.elk.layered.layering.layerConstraint'] = 'FIRST';
    } else if (type === 'mcu' || type === 'sensor') {
      layoutOptions['org.eclipse.elk.layered.layering.layerConstraint'] = 'LAST';
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
    if ((netRoles.get(net) || 'signal') !== 'signal') return;
    if (pins.length < 2) return;
    const hubId = `hub:${net}`;
    signalHubs.push({ id: hubId, width: 8, height: 8 });
    pins.forEach((entry, index) => {
      elkEdges.push({
        id: `e:${net}:${index}`,
        sources: [portId(entry.component, entry.pin)],
        targets: [hubId],
      });
    });
  });

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '55',
      'elk.layered.spacing.nodeNodeBetweenLayers': '95',
      'elk.spacing.portPort': '22',
      'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.separateConnectedComponents': 'true',
    },
    children: [...elkNodes, ...signalHubs],
    edges: elkEdges,
  };

  const laid = await elk.layout(graph);
  const positioned = new Map<string, { x: number; y: number }>();
  (laid.children || []).forEach((child) => {
    if (typeof child.x === 'number' && typeof child.y === 'number') {
      positioned.set(child.id, { x: child.x, y: child.y });
    }
  });

  // ELK top-left positions -> grid-snapped component centres.
  let centres = components.map((node) => {
    const box = boxById.get(node.id)!;
    const pos = positioned.get(node.id) || { x: 0, y: 0 };
    return { id: node.id, x: snap(pos.x + box.width / 2), y: snap(pos.y + box.height / 2) };
  });

  // Shift the drawing into left/top margins, leaving room for the power rails.
  const powerNetCount = [...netRoles.values()].filter((role) => role === 'power').length;
  const lanes = Math.max(1, powerNetCount);
  const topBand = RAIL_GAP + lanes * POWER_LANE_STEP;

  let minX = Infinity;
  let minY = Infinity;
  centres.forEach((centre) => {
    const box = boxById.get(centre.id)!;
    minX = Math.min(minX, centre.x - box.width / 2);
    minY = Math.min(minY, centre.y - box.height / 2);
  });
  const tx = snap(MARGIN_X - minX);
  const ty = snap(topBand - minY);
  centres = centres.map((centre) => ({ id: centre.id, x: centre.x + tx, y: centre.y + ty }));

  // De-overlap pass: keep wires from running through symbols.
  //
  // ELK packs every member of a net into a single column, which stacks parallel
  // shunt branches collinearly — e.g. a divider's lower resistor and a
  // decoupling cap (both signal->gnd) end up in one column, so each one's stub
  // crosses the other's body. We can't tell the divider's series leg from the
  // shunt cap by net role (both are signal+gnd); the giveaway is geometric, so
  // we detect a stub that traverses another symbol and fan the lower component
  // out into its own column, lifted so its signal pin sits just under the trunk.
  const meta = new Map(
    components.map((node) => [
      node.id,
      { type: String(node.data?.type || 'component').toLowerCase(), orientation: orientationById.get(node.id)!, pins: pinsOf(node) },
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
    meta.forEach((m, id) => m.pins.forEach((pin) => { if (pin.net === net) ys.push(pinAbs(id, pin).y); }));
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length / 2)] || 0;
  };
  const targetY = (net: string): number => {
    const role = netRoles.get(net) || 'signal';
    if (role === 'ground') return GROUND_SENTINEL;
    if (role === 'power') return POWER_SENTINEL;
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
        // Fan the lower of the two out into a free column.
        const mover = blocker.y > b.y ? blocker : b;
        const mm = meta.get(mover.id)!;
        const moverBox = boxById.get(mover.id)!;
        const signalPin = mm.pins.find((candidate) => (netRoles.get(candidate.net) || 'signal') === 'signal');
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
function pinOffset(
  type: string,
  orientation: 'horizontal' | 'vertical',
  pins: Pin[],
  pin: Pin,
): Point {
  const pinName = normalizedPin(pin.name);

  if (type === 'bjt') {
    if (pinName === 'B') return { x: -58, y: 0 };
    if (pinName === 'C') return { x: 38, y: -86 };
    if (pinName === 'E') return { x: 38, y: 86 };
  }
  if (type === 'mosfet') {
    if (pinName === 'G') return { x: -62, y: 0 };
    if (pinName === 'D') return { x: 38, y: -86 };
    if (pinName === 'S') return { x: 38, y: 86 };
  }
  if (type === 'ldo') {
    if (pinName === 'IN') return { x: -90, y: -18 };
    if (pinName === 'OUT') return { x: 90, y: -18 };
    if (pinName === 'GND') return { x: 0, y: 80 };
  }
  if (type === 'mcu' || type === 'sensor') {
    if (pinName.includes('GND')) return { x: -20, y: 88 };
    if (pinName.includes('3V') || pinName.includes('VCC') || pinName.includes('VDD')) return { x: -20, y: -88 };
    if (pin.function?.includes('ADC') || pinName.includes('GPIO4')) return { x: -92, y: -8 };
    const index = pins.findIndex((candidate) => candidate.name === pin.name);
    return { x: 92, y: -34 + index * 20 };
  }
  if (type === 'voltage_source' || type === 'current_source' || type === 'battery') {
    if (pinName === '+' || pinName === '1') return { x: 0, y: -74 };
    if (pinName === '-' || pinName === '2') return { x: 0, y: 74 };
  }

  if (orientation === 'vertical') {
    if (pinName === '1' || pinName === 'A' || pinName === '+') return { x: 0, y: -68 };
    return { x: 0, y: 68 };
  }
  if (pinName === '1' || pinName === 'A' || pinName === '+') return { x: -76, y: 0 };
  return { x: 76, y: 0 };
}

function pinPoint(component: SchematicComponent, pin: Pin): PinPoint {
  const offset = pinOffset(component.type, component.orientation, component.pins, pin);
  return {
    component: component.id,
    pin: pin.name,
    net: pin.net,
    x: component.x + offset.x,
    y: component.y + offset.y,
  };
}

function orientationFor(type: string): 'horizontal' | 'vertical' {
  return type === 'mcu' || type === 'sensor' || type === 'ldo' ? 'horizontal' : 'vertical';
}

/**
 * Axis-aligned bounding box of a component, derived from its pin extents so
 * ELK reserves enough space around each symbol (including its leads).
 */
function componentBox(type: string, orientation: 'horizontal' | 'vertical', pins: Pin[]): { width: number; height: number } {
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

async function buildSchematic(nodes: Node[], edges: Edge[]): Promise<SchematicIR> {
  const netRoles = new Map<string, 'power' | 'ground' | 'signal'>();
  nodes.filter((node) => node.type === 'net').forEach((node) => {
    netRoles.set(String(node.data?.label || String(node.id).replace(/^net:/, '')), roleOf(node.data?.role));
  });

  edges.forEach((edge) => {
    const net = String(edge.data?.net || String(edge.target).replace(/^net:/, ''));
    if (!netRoles.has(net)) netRoles.set(net, 'signal');
  });

  const layout = await layoutComponents(nodes, netRoles);
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
    .filter((net) => (netRoles.get(net) || 'signal') === 'power')
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
    ['resistor', 'capacitor', 'diode', 'generic_load'].includes(component.type) && component.orientation === 'vertical';
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
    component.labelSide = !leftOk && rightOk ? 'right' : leftOk && !rightOk ? 'left' : rightGap > leftGap ? 'right' : 'left';
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
    const role = netRoles.get(net) || 'signal';
    return {
      id: net,
      role,
      label: net,
      laneY: role === 'power' ? powerLane.get(net) : role === 'ground' ? layout.groundY : undefined,
      labelX: role === 'signal' && points.length > 1 ? signalLabelX(points) : undefined,
      points,
    };
  });

  return { components, nets, width: layout.width, height: layout.height };
}

function segmentPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function netStroke(role: NetShape['role']): string {
  if (role === 'power') return POWER_COLOR;
  if (role === 'ground') return GROUND_COLOR;
  return SIGNAL_COLOR;
}

function netLabelPoint(net: NetShape, minX: number): Point {
  if (net.role === 'ground') return { x: minX + 8, y: (net.laneY || GROUND_Y) + 20 };
  if (net.role === 'power') return { x: minX + 8, y: (net.laneY || POWER_Y) - 10 };
  const trunkY = net.trunkY || median(net.points.map((point) => point.y));
  return { x: net.labelX ?? minX + 132, y: trunkY - 24 };
}

function NetWires({ net }: { net: NetShape }) {
  if (net.points.length === 0) return null;
  const stroke = netStroke(net.role);
  const paths: string[] = [];
  const junctions: Point[] = [];
  const xs = net.points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const signalTrunkY = net.trunkY || median(net.points.map((point) => point.y));

  // Dot only at interior T-junctions (stub x strictly between rail endpoints).
  const addJunction = (x: number, y: number) => {
    if (x > minX && x < maxX) junctions.push({ x, y });
  };

  if (net.role === 'power') {
    const railY = net.laneY || POWER_Y;
    paths.push(segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([{ x: point.x, y: railY }, point]));
      addJunction(point.x, railY);
    });
  } else if (net.role === 'ground') {
    const railY = net.laneY || GROUND_Y;
    paths.push(segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([point, { x: point.x, y: railY }]));
      addJunction(point.x, railY);
    });
  } else if (net.points.length === 1) {
    // single isolated net — no wire drawn
  } else {
    const trunkY = signalTrunkY;
    paths.push(segmentPath([{ x: minX, y: trunkY }, { x: maxX, y: trunkY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([point, { x: point.x, y: trunkY }]));
      addJunction(point.x, trunkY);
    });
  }

  const uniqueJunctions = [...new Map(junctions.map((p) => [`${p.x}:${p.y}`, p])).values()];

  return (
    <g className={`schematic-net-wire ${net.role}`}>
      {paths.map((path, index) => (
        <React.Fragment key={`${net.id}:${index}`}>
          <path className="wire-underlay" d={path} />
          <path className="wire-stroke" d={path} stroke={stroke} />
        </React.Fragment>
      ))}
      {uniqueJunctions.map((p) => (
        <circle className="schematic-junction" key={`${net.id}:${p.x}:${p.y}`} cx={p.x} cy={p.y} r="5" />
      ))}
      <text className={`schematic-net-label ${net.role}`} x={netLabelPoint(net, minX).x} y={netLabelPoint(net, minX).y}>
        {net.label}
      </text>
    </g>
  );
}

function ResistorSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === 'vertical';
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? 'rotate(90)' : ''}`}>
      <path className="symbol-line" d="M-76 0H-46l8-14 16 28 16-28 16 28 16-28 16 28 8-14H76" />
    </g>
  );
}

function CapacitorSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === 'vertical';
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? 'rotate(90)' : ''}`}>
      <path className="symbol-line" d="M-70 0h52M-18 -28v56M18 -28v56M18 0h52" />
    </g>
  );
}

function SourceSvg({ c }: { c: SchematicComponent }) {
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <circle className="source-body" cx="0" cy="0" r="42" />
      <path className="symbol-line" d="M0 -74v32M0 42v32M-13 -14h26M0 -27V0M-13 21h26" />
    </g>
  );
}

function DiodeSvg({ c }: { c: SchematicComponent }) {
  const vertical = c.orientation === 'vertical';
  return (
    <g transform={`translate(${c.x} ${c.y}) ${vertical ? 'rotate(90)' : ''}`}>
      <path className="symbol-line" d="M-76 0h42M34 0h42M-34 -24l48 24-48 24zM28 -28v56" />
    </g>
  );
}

function BjtSvg({ c }: { c: SchematicComponent }) {
  const isPnp = c.spiceModel.toUpperCase() === 'PNP';
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <circle className="symbol-shell" cx="20" cy="0" r="54" />
      <path className="symbol-line" d="M-10 -40v80M-88 0h78M-10 0l48 -58M-10 0l48 58M38 -58v-28M38 58v28" />
      {isPnp ? <path className="symbol-fill" d="M10 -10l23 -1 -13 -18z" /> : <path className="symbol-fill" d="M50 40l16 18 -25 -4z" />}
    </g>
  );
}

function MosfetSvg({ c }: { c: SchematicComponent }) {
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <path className="symbol-line" d="M-26 -48v96M-8 -44v24M-8 -12v24M-8 20v24M-88 0h62M-8 -32h46v-54M-8 32h46v54M16 0h22" />
      <path className="symbol-fill" d="M18 -9l26 9-26 9z" />
    </g>
  );
}

function IcSvg({ c }: { c: SchematicComponent }) {
  const label = c.type === 'mcu' ? 'MCU' : c.type.toUpperCase();
  const BL = -74, BR = 74, BT = -64, BB = 64;
  return (
    <g transform={`translate(${c.x} ${c.y})`}>
      <rect className="ic-body" x={BL} y={BT} width={BR - BL} height={BB - BT} rx="4" />
      {c.pins.map((pin) => {
        const off = pinOffset(c.type, c.orientation, c.pins, pin);
        let ex: number, ey: number;
        if (off.x <= BL)      { ex = BL; ey = off.y; }
        else if (off.x >= BR) { ex = BR; ey = off.y; }
        else if (off.y <= BT) { ex = off.x; ey = BT; }
        else if (off.y >= BB) { ex = off.x; ey = BB; }
        else return null;
        return <path key={pin.name} className="ic-pin" d={`M${ex} ${ey}L${off.x} ${off.y}`} />;
      })}
      <text className="ic-name" x="0" y="-4">{label}</text>
      {c.part && <text className="ic-part" x="0" y="18">{c.part}</text>}
    </g>
  );
}

function ComponentSvg({ component }: { component: SchematicComponent }) {
  const c = component;
  let symbol: React.ReactNode;
  if (c.type === 'resistor' || c.type === 'generic_load') symbol = <ResistorSvg c={c} />;
  else if (c.type === 'capacitor') symbol = <CapacitorSvg c={c} />;
  else if (c.type === 'diode') symbol = <DiodeSvg c={c} />;
  else if (c.type === 'voltage_source' || c.type === 'current_source' || c.type === 'battery') symbol = <SourceSvg c={c} />;
  else if (c.type === 'bjt') symbol = <BjtSvg c={c} />;
  else if (c.type === 'mosfet') symbol = <MosfetSvg c={c} />;
  else symbol = <IcSvg c={c} />;

  const isVerticalPassive = ['resistor', 'capacitor', 'diode', 'generic_load'].includes(c.type) && c.orientation === 'vertical';
  const labelRight = isVerticalPassive && c.labelSide === 'right';
  const labelX = isVerticalPassive ? c.x + (labelRight ? 66 : -66) : c.x;
  const labelY = c.type === 'bjt' || c.type === 'mosfet' ? c.y + 118 : isVerticalPassive ? c.y + 8 : c.orientation === 'vertical' ? c.y + 94 : c.y + 42;
  const value = c.value || (c.type !== 'mcu' ? c.part : '');
  const showPinText = ['mcu', 'sensor', 'ldo', 'bjt', 'mosfet'].includes(c.type);
  // Side labels anchor away from the symbol: end (grows left) on the left, start (grows right) on the right.
  const sideAnchor = labelRight ? 'start' : undefined;

  return (
    <g className={`schematic-component ${c.type}`}>
      {symbol}
      <text className={`component-ref ${isVerticalPassive ? 'side-label' : ''}`} x={labelX} y={labelY} style={sideAnchor ? { textAnchor: sideAnchor } : undefined}>{c.id}</text>
      {value && <text className={`component-value ${isVerticalPassive ? 'side-label' : ''}`} x={labelX} y={labelY + 16} style={sideAnchor ? { textAnchor: sideAnchor } : undefined}>{value}</text>}
      {c.pins.map((pin) => {
        const point = pinPoint(c, pin);
        return (
          <g key={`${c.id}:${pin.name}`} className="pin-marker">
            <circle cx={point.x} cy={point.y} r="3" />
            {showPinText && <text x={point.x + 5} y={point.y - 5}>{pin.name}</text>}
          </g>
        );
      })}
    </g>
  );
}

const Graph: React.FC<GraphProps> = ({ nodes, edges }) => {
  const [schematic, setSchematic] = useState<SchematicIR | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildSchematic(nodes, edges)
      .then((result) => {
        if (!cancelled) setSchematic(result);
      })
      .catch((error) => console.error('Schematic layout failed:', error));
    return () => {
      cancelled = true;
    };
  }, [nodes, edges]);

  return (
    <div className="schematic-canvas svg-schematic-canvas">
      <div className="schematic-titlebar">
        <div>
          <span className="eyebrow">Schematic Canvas</span>
          <strong>Auto-routed electrical drawing</strong>
        </div>
        <div className="schematic-legend" aria-label="schematic legend">
          <span className="legend power">Power</span>
          <span className="legend signal">Signal</span>
          <span className="legend ground">Ground</span>
        </div>
      </div>
      {schematic ? (
        <svg className="native-schematic" viewBox={`0 0 ${schematic.width} ${schematic.height}`} role="img" aria-label="AIR schematic">
          <defs>
            <pattern id="schematic-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" fill="none" stroke="#e4e9f1" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#schematic-grid)" />
          <g className="wire-layer">
            {schematic.nets.map((net) => <NetWires key={net.id} net={net} />)}
          </g>
          <g className="component-layer">
            {schematic.components.map((component) => <ComponentSvg key={component.id} component={component} />)}
          </g>
        </svg>
      ) : (
        <div className="schematic-loading">Laying out schematic…</div>
      )}
    </div>
  );
};

export default Graph;
