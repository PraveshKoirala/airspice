/**
 * Schematic renderer (issue #22 refactor).
 *
 * The React component that draws the SVG schematic. Extracted from the
 * pre-refactor Graph.tsx; the DOM output (viewBox, background grid pattern,
 * wire and component layers, net labels) is byte-identical to the monolith
 * for hint-less designs -- verified by scripts/schematic-parity.
 *
 * On top of the pure refactor, this file adds the SELECTION plumbing:
 *   - clicking a component fires `selectComponent(id)` on the schematic UI
 *     store; the `.selected` class flows through to the outer <g>;
 *   - clicking a wire fires `selectNet(id)`;
 *   - clicking the SVG background (or pressing Escape) clears the selection.
 *
 * `<gui>` hints (issue #22 B) are parsed from the XML by air-ts and passed
 * in as `hints`. layoutComponents pins hinted components at their stored
 * (x,y) and skips ELK for them; un-hinted components still get auto-routed.
 */

import React, { useEffect, useMemo, useState } from "react";
import type { Edge, Node } from "reactflow";
import type { GuiHint, NetShape, SchematicIR } from "./types";
import { buildSchematic, GRID, median, segmentPath } from "./layout";
import { ComponentSvg } from "./symbols";
import { useSchematicUI, type Selection } from "./interaction";

const POWER_Y = 92;
const GROUND_Y = 620;
const SIGNAL_COLOR = "#0f766e";
const POWER_COLOR = "#b45309";
const GROUND_COLOR = "#475569";

function netStroke(role: NetShape["role"]): string {
  if (role === "power") return POWER_COLOR;
  if (role === "ground") return GROUND_COLOR;
  return SIGNAL_COLOR;
}

function netLabelPoint(net: NetShape, minX: number) {
  if (net.role === "ground") return { x: minX + 8, y: (net.laneY || GROUND_Y) + 20 };
  if (net.role === "power") return { x: minX + 8, y: (net.laneY || POWER_Y) - 10 };
  const trunkY = net.trunkY || median(net.points.map((point) => point.y));
  return { x: net.labelX ?? minX + 132, y: trunkY - 24 };
}

/**
 * The wires for one net. Renders the rail/trunk plus a stub for every pin.
 *
 * `onSelect` is optional so the pure refactor commit remains behavior-
 * neutral; when present, clicking any wire segment or the net label
 * selects the net. The `selected` class thickens the stroke via CSS. The
 * hitbox path is transparent-but-wider than the visible stroke so
 * click-to-select doesn't require pixel accuracy on a thin wire.
 */
function NetWires({
  net,
  selected = false,
  onSelect,
}: {
  net: NetShape;
  selected?: boolean;
  onSelect?: () => void;
}) {
  if (net.points.length === 0) return null;
  const stroke = netStroke(net.role);
  const paths: string[] = [];
  const junctions: { x: number; y: number }[] = [];
  const xs = net.points.map((point) => point.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const signalTrunkY = net.trunkY || median(net.points.map((point) => point.y));

  // Dot only at interior T-junctions (stub x strictly between rail endpoints).
  const addJunction = (x: number, y: number) => {
    if (x > minX && x < maxX) junctions.push({ x, y });
  };

  if (net.role === "power") {
    const railY = net.laneY || POWER_Y;
    paths.push(segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([{ x: point.x, y: railY }, point]));
      addJunction(point.x, railY);
    });
  } else if (net.role === "ground") {
    const railY = net.laneY || GROUND_Y;
    paths.push(segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([point, { x: point.x, y: railY }]));
      addJunction(point.x, railY);
    });
  } else if (net.points.length === 1) {
    // single isolated net -- no wire drawn
  } else {
    const trunkY = signalTrunkY;
    paths.push(segmentPath([{ x: minX, y: trunkY }, { x: maxX, y: trunkY }]));
    net.points.forEach((point) => {
      paths.push(segmentPath([point, { x: point.x, y: trunkY }]));
      addJunction(point.x, trunkY);
    });
  }

  const uniqueJunctions = [...new Map(junctions.map((p) => [`${p.x}:${p.y}`, p])).values()];

  const groupProps: React.SVGProps<SVGGElement> = {
    className: `schematic-net-wire ${net.role}${selected ? " selected" : ""}`,
  };
  if (onSelect) {
    groupProps.onClick = (event) => {
      event.stopPropagation();
      onSelect();
    };
    groupProps.style = { cursor: "pointer" };
  }
  return (
    <g {...groupProps} data-net-id={net.id}>
      {paths.map((path, index) => (
        <React.Fragment key={`${net.id}:${index}`}>
          <path className="wire-underlay" d={path} />
          <path className="wire-stroke" d={path} stroke={stroke} />
          {/* Wider transparent hitbox so click-to-select tolerates thin wires. */}
          {onSelect && (
            <path
              className="wire-hitbox"
              d={path}
              stroke="transparent"
              strokeWidth={12}
              fill="none"
              pointerEvents="stroke"
            />
          )}
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

export interface RendererProps {
  nodes: Node[];
  edges: Edge[];
  /** `<gui>` position hints parsed from the design XML (issue #22 B). */
  hints?: GuiHint[];
  /**
   * When `true`, click and keyboard handlers are attached so the schematic
   * UI store's selection can be driven from the canvas. When `false` (the
   * default in the pure-refactor commit), the SVG renders exactly as it did
   * in the monolith with no interaction plumbing at all -- this is what the
   * parity snapshot verifies.
   */
  interactive?: boolean;
  /**
   * Called after every successful layout with the placed components (their
   * final x/y). Used by the Inspector's "Save layout" action to capture a
   * <gui> patch for each component. Not called on layout failures.
   */
  onLayout?: (ir: SchematicIR) => void;
}

const Renderer: React.FC<RendererProps> = ({ nodes, edges, hints = [], interactive = false, onLayout }) => {
  const [schematic, setSchematic] = useState<SchematicIR | null>(null);
  const selection = useSchematicUI((s) => s.selection);
  const selectComponent = useSchematicUI((s) => s.selectComponent);
  const selectNet = useSchematicUI((s) => s.selectNet);
  const clear = useSchematicUI((s) => s.clear);

  // Recompute layout whenever the graph or hints change.
  useEffect(() => {
    let cancelled = false;
    buildSchematic(nodes, edges, hints)
      .then((result) => {
        if (cancelled) return;
        setSchematic(result);
        onLayout?.(result);
      })
      .catch((error) => console.error("Schematic layout failed:", error));
    return () => {
      cancelled = true;
    };
    // hints is a plain array; we intentionally re-run when its identity changes.
  }, [nodes, edges, hints, onLayout]);

  // Escape clears selection when the schematic tab is showing an interactive canvas.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive, clear]);

  // Derive: which nets should light up because the selection is on them?
  //   - net selection -> that net's id is highlighted
  //   - component selection -> every net connected to that component's pins
  const highlightedNets = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (!schematic || !selection) return set;
    if (selection.kind === "net") {
      set.add(selection.id);
      return set;
    }
    // component selection: gather its pin nets
    const c = schematic.components.find((component) => component.id === selection.id);
    c?.pins.forEach((pin) => {
      if (pin.net) set.add(pin.net);
    });
    return set;
  }, [schematic, selection]);

  const compSelected = (id: string) => selection?.kind === "component" && selection.id === id;
  const netSelectedClass = (id: string) => selection?.kind === "net" && selection.id === id;
  const netHighlighted = (id: string) => highlightedNets.has(id);

  const backgroundClick = interactive ? () => clear() : undefined;

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
        <svg
          className="native-schematic"
          viewBox={`0 0 ${schematic.width} ${schematic.height}`}
          role="img"
          aria-label="AIR schematic"
          onClick={backgroundClick}
          data-testid="schematic-svg"
        >
          <defs>
            <pattern id="schematic-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
              <path d={`M${GRID} 0H0V${GRID}`} fill="none" stroke="#e4e9f1" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#schematic-grid)" />
          <g className="wire-layer">
            {schematic.nets.map((net) => {
              const highlighted = netHighlighted(net.id);
              const isSelected = netSelectedClass(net.id);
              const netProps: { net: NetShape; selected?: boolean; onSelect?: () => void } = {
                net,
                selected: isSelected || highlighted,
              };
              if (interactive) netProps.onSelect = () => selectNet(net.id);
              return <NetWires key={net.id} {...netProps} />;
            })}
          </g>
          <g className="component-layer">
            {schematic.components.map((component) => {
              const props: {
                component: typeof component;
                selected?: boolean;
                highlightedNets?: Set<string>;
                onSelect?: () => void;
              } = { component };
              if (interactive) {
                props.selected = compSelected(component.id);
                props.highlightedNets = highlightedNets;
                props.onSelect = () => selectComponent(component.id);
              }
              return <ComponentSvg key={component.id} {...props} />;
            })}
          </g>
        </svg>
      ) : (
        <div className="schematic-loading">Laying out schematic…</div>
      )}
    </div>
  );
};

export default Renderer;
export type { Selection };
