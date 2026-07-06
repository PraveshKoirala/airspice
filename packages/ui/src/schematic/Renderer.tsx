/**
 * Schematic renderer (issue #22 refactor + issue #23 drag/nudge/marquee).
 *
 * The React component that draws the SVG schematic. Extracted from the
 * pre-refactor Graph.tsx; the DOM output for hint-less, non-interactive
 * designs is byte-identical to the monolith -- verified by
 * scripts/schematic-parity.
 *
 * INTERACTION (only when `interactive` is `true`):
 *   - Click a component to select it (replaces the current selection).
 *   - Shift-click a component to toggle it in/out of the current selection.
 *   - Click a wire to select the net (single-select only).
 *   - Click the background (or press Escape) to clear.
 *   - Drag on the background to draw a marquee rectangle; on release,
 *     every component the rectangle intersects becomes the new selection
 *     (or, with Shift held, is added to it).
 *   - Drag on a selected component to move it (and the whole selection
 *     with it). On drop, one `<patch>` is emitted with one `<gui>` op per
 *     dragged component and committed through `runGate` -> `setUserXml`,
 *     so undo restores the whole group in a single step.
 *   - Arrow keys nudge the current component selection by one grid step
 *     (10px); Shift+Arrow nudges by 5 steps. The same patch path is used
 *     as drop, so nudge and drag persist identically.
 *
 * PERFORMANCE INVARIANT (issue #23 acceptance):
 *   During a drag NOTHING triggers a React re-render past the first
 *   `beginDrag` flip. Pointer moves are throttled to rAF and update
 *   * `transform` on the outer component group via a ref,
 *   * `d` on each connected wire via a ref -- straight-line stubs from
 *     the moved pin to the trunk (which is now `y=avg(pins)` computed
 *     on the fly),
 *   * `x`/`y`/`width`/`height` on the marquee `<rect>` via a ref.
 *   No XML is parsed, no `<patch>` is built, no store is dispatched, and
 *   ELK is not re-run. Only on `pointerup` does the drop path build one
 *   patch, feed it through `runGate`, and hand the canonical XML to the
 *   design store. If the patch fails the gate, we roll back the DOM
 *   transforms so the schematic snaps back to the pre-drag position.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Edge, Node } from "reactflow";
import type { GuiHint, NetShape, SchematicIR } from "./types";
import { buildSchematic, GRID, median, segmentPath } from "./layout";
import { ComponentSvg } from "./symbols";
import {
  DRAG_GRID,
  snapDrag,
  useSchematicUI,
  type Selection,
} from "./interaction";

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
 * For issue #23 we also stamp each stub path with `data-net`,
 * `data-comp`, `data-pin-x`, `data-pin-y` so the drag layer can rewrite
 * the stub's `d` attribute in place (without a React re-render) when the
 * pin's owning component is being dragged. The trunk path carries
 * `data-net-trunk` and the pin coordinates for the two endpoints so it
 * too can be rewritten in place.
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
  type StubMeta = { d: string; kind: "trunk" | "stub"; comp?: string; px?: number; py?: number };
  const paths: StubMeta[] = [];
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
    paths.push({ d: segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]), kind: "trunk" });
    net.points.forEach((point) => {
      paths.push({
        d: segmentPath([{ x: point.x, y: railY }, point]),
        kind: "stub",
        comp: point.component,
        px: point.x,
        py: point.y,
      });
      addJunction(point.x, railY);
    });
  } else if (net.role === "ground") {
    const railY = net.laneY || GROUND_Y;
    paths.push({ d: segmentPath([{ x: minX, y: railY }, { x: maxX, y: railY }]), kind: "trunk" });
    net.points.forEach((point) => {
      paths.push({
        d: segmentPath([point, { x: point.x, y: railY }]),
        kind: "stub",
        comp: point.component,
        px: point.x,
        py: point.y,
      });
      addJunction(point.x, railY);
    });
  } else if (net.points.length === 1) {
    // single isolated net -- no wire drawn
  } else {
    const trunkY = signalTrunkY;
    paths.push({ d: segmentPath([{ x: minX, y: trunkY }, { x: maxX, y: trunkY }]), kind: "trunk" });
    net.points.forEach((point) => {
      paths.push({
        d: segmentPath([point, { x: point.x, y: trunkY }]),
        kind: "stub",
        comp: point.component,
        px: point.x,
        py: point.y,
      });
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
      {paths.map((seg, index) => (
        <React.Fragment key={`${net.id}:${index}`}>
          <path
            className="wire-underlay"
            d={seg.d}
            data-net={net.id}
            data-kind={seg.kind}
            data-underlay={1}
            {...(seg.comp !== undefined ? { "data-comp": seg.comp } : {})}
            {...(seg.px !== undefined ? { "data-pin-x": seg.px } : {})}
            {...(seg.py !== undefined ? { "data-pin-y": seg.py } : {})}
          />
          <path
            className="wire-stroke"
            d={seg.d}
            stroke={stroke}
            data-net={net.id}
            data-kind={seg.kind}
            {...(seg.comp !== undefined ? { "data-comp": seg.comp } : {})}
            {...(seg.px !== undefined ? { "data-pin-x": seg.px } : {})}
            {...(seg.py !== undefined ? { "data-pin-y": seg.py } : {})}
          />
          {/* Wider transparent hitbox so click-to-select tolerates thin wires. */}
          {onSelect && (
            <path
              className="wire-hitbox"
              d={seg.d}
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
   * When `true`, click/drag/keyboard handlers are attached so the
   * schematic UI store can be driven from the canvas. When `false` (the
   * default in the pure-refactor commit), the SVG renders exactly as it
   * did in the monolith with no interaction plumbing at all -- this is
   * what the parity snapshot verifies.
   */
  interactive?: boolean;
  /**
   * Called after every successful layout with the placed components (their
   * final x/y). Used by the Inspector's "Save layout" action to capture a
   * <gui> patch for each component. Not called on layout failures.
   */
  onLayout?: (ir: SchematicIR) => void;
  /**
   * Issue #23 write path: on drop or on a keyboard nudge, the Renderer
   * hands the list of (id, snapped x, snapped y) moves here. The app
   * parses the current design once, builds ONE `<patch>` with one
   * `<gui>` op per move (via patches.saveHintsPatch), runs it through
   * `runGate`, and either calls `setUserXml` or returns an error
   * message. On error, the Renderer rolls back the pending DOM
   * transforms so the schematic snaps back to its pre-drag position.
   */
  onCommitMove?: (moves: Array<{ id: string; x: number; y: number }>) => { ok: true } | { ok: false; message: string };
}

const Renderer: React.FC<RendererProps> = ({
  nodes,
  edges,
  hints = [],
  interactive = false,
  onLayout,
  onCommitMove,
}) => {
  const [schematic, setSchematic] = useState<SchematicIR | null>(null);
  const selectedComponents = useSchematicUI((s) => s.selectedComponents);
  const selectedNet = useSchematicUI((s) => s.selectedNet);
  const selectComponent = useSchematicUI((s) => s.selectComponent);
  const toggleComponent = useSchematicUI((s) => s.toggleComponent);
  const replaceComponentSelection = useSchematicUI((s) => s.replaceComponentSelection);
  const selectNet = useSchematicUI((s) => s.selectNet);
  const clear = useSchematicUI((s) => s.clear);
  const beginDrag = useSchematicUI((s) => s.beginDrag);
  const endDrag = useSchematicUI((s) => s.endDrag);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const marqueeRectRef = useRef<SVGRectElement | null>(null);

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

  // The drop / nudge write path. Build ONE <patch> with one op per moved
  // component so the whole group undoes in a single Monaco/design-store
  // history step (issue #23 acceptance criterion).
  //
  // We reference the freshest schematic + onCommitMove through refs so
  // the keydown/pointer handlers don't need to re-bind on every layout.
  // Refs are synced inside a useEffect (React 19 rules-of-hooks:
  // ref.current assignment during render is disallowed).
  const schematicRef = useRef<SchematicIR | null>(schematic);
  const onCommitMoveRef = useRef<RendererProps["onCommitMove"]>(onCommitMove);
  useEffect(() => {
    schematicRef.current = schematic;
  }, [schematic]);
  useEffect(() => {
    onCommitMoveRef.current = onCommitMove;
  }, [onCommitMove]);

  const commitMove = useCallback((ids: string[], dx: number, dy: number) => {
    const ir = schematicRef.current;
    if (!ir) return;
    const commit = onCommitMoveRef.current;
    if (!commit) return;
    const snappedDx = snapDrag(dx);
    const snappedDy = snapDrag(dy);
    if (snappedDx === 0 && snappedDy === 0) return;
    const moves = ids
      .map((id) => {
        const placed = ir.components.find((c) => c.id === id);
        if (!placed) return null;
        return {
          id,
          x: snapDrag(placed.x + snappedDx),
          y: snapDrag(placed.y + snappedDy),
        };
      })
      .filter((m): m is { id: string; x: number; y: number } => m !== null);
    if (moves.length === 0) return;
    commit(moves);
  }, []);

  // Escape clears selection; arrow keys nudge the selected components.
  useEffect(() => {
    if (!interactive) return;
    const onKey = (event: KeyboardEvent) => {
      // Ignore keystrokes typed into any editable control (Inspector, editor, etc.)
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "Escape") {
        clear();
        return;
      }
      const arrow =
        event.key === "ArrowLeft" ? { dx: -1, dy: 0 }
        : event.key === "ArrowRight" ? { dx: 1, dy: 0 }
        : event.key === "ArrowUp" ? { dx: 0, dy: -1 }
        : event.key === "ArrowDown" ? { dx: 0, dy: 1 }
        : null;
      if (!arrow) return;
      const ids = [...useSchematicUI.getState().selectedComponents];
      if (ids.length === 0) return;
      event.preventDefault();
      const step = event.shiftKey ? 5 * DRAG_GRID : DRAG_GRID;
      const dx = arrow.dx * step;
      const dy = arrow.dy * step;
      commitMove(ids, dx, dy);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interactive, clear, commitMove]);

  // Derive: which nets should light up because the selection is on them?
  //   - net selection -> that net's id is highlighted
  //   - any component selection -> every net connected to any selected pin
  const highlightedNets = useMemo<Set<string>>(() => {
    const set = new Set<string>();
    if (!schematic) return set;
    if (selectedNet) {
      set.add(selectedNet);
      return set;
    }
    schematic.components.forEach((c) => {
      if (!selectedComponents.has(c.id)) return;
      c.pins.forEach((pin) => {
        if (pin.net) set.add(pin.net);
      });
    });
    return set;
  }, [schematic, selectedNet, selectedComponents]);

  const compSelected = (id: string) => selectedComponents.has(id);
  const netSelectedClass = (id: string) => selectedNet === id;
  const netHighlighted = (id: string) => highlightedNets.has(id);

  // ------------------------------------------------------------------
  // Drag state (transform-layer preview; ZERO React re-renders per frame)
  // ------------------------------------------------------------------
  //
  // On pointer-down on a selected component we capture the pointer to the
  // SVG and remember (1) which components are moving, (2) the starting
  // screen pointer position converted to SVG user coords, (3) the pending
  // dx/dy the pointerMove handler will keep updating. rAF drains the
  // pending offset into the DOM: one `transform: translate` per moving
  // group and one `d` rewrite per connected wire segment.
  interface DragState {
    kind: "component";
    ids: Set<string>;
    startX: number;
    startY: number;
    pendingDx: number;
    pendingDy: number;
    rafScheduled: boolean;
    lastAppliedDx: number;
    lastAppliedDy: number;
    // Precomputed per-net trunk data so we can rewrite trunk paths quickly:
    // for each net that has AT LEAST ONE pin belonging to a moving
    // component, we remember its non-moving pin ys and the ys of the
    // moving component's pins so we can regenerate a straight-line
    // trunk-through-median without a full layout pass.
    netsTouched: Set<string>;
  }
  interface MarqueeState {
    kind: "marquee";
    shift: boolean;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  }
  const dragRef = useRef<DragState | MarqueeState | null>(null);

  const svgClientToUser = (event: PointerEvent | React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const vbW = viewBox.width || rect.width;
    const vbH = viewBox.height || rect.height;
    // preserveAspectRatio=xMidYMid meet is the SVG default -- work out the
    // effective scale + letterboxing so the pointer maps 1:1 into user coords.
    const scale = Math.min(rect.width / vbW, rect.height / vbH);
    const drawnW = vbW * scale;
    const drawnH = vbH * scale;
    const offX = (rect.width - drawnW) / 2;
    const offY = (rect.height - drawnH) / 2;
    return {
      x: (event.clientX - rect.left - offX) / scale,
      y: (event.clientY - rect.top - offY) / scale,
    };
  };

  const applyDragToDom = useCallback(() => {
    const state = dragRef.current;
    const svg = svgRef.current;
    if (!svg || !state) return;

    if (state.kind === "marquee") {
      const rectEl = marqueeRectRef.current;
      if (rectEl) {
        const x = Math.min(state.startX, state.curX);
        const y = Math.min(state.startY, state.curY);
        const w = Math.abs(state.curX - state.startX);
        const h = Math.abs(state.curY - state.startY);
        rectEl.setAttribute("x", String(x));
        rectEl.setAttribute("y", String(y));
        rectEl.setAttribute("width", String(w));
        rectEl.setAttribute("height", String(h));
      }
      return;
    }

    // Component drag: snap the pending offset once per frame, translate
    // every moving component's outer <g>, and redraw the affected wires
    // as straight lines from the moved pin(s) to the (recomputed) trunk.
    const dx = snapDrag(state.pendingDx);
    const dy = snapDrag(state.pendingDy);
    if (dx === state.lastAppliedDx && dy === state.lastAppliedDy) return;
    state.lastAppliedDx = dx;
    state.lastAppliedDy = dy;

    // 1) Translate every moving component's <g data-component-id>.
    state.ids.forEach((id) => {
      const g = svg.querySelector<SVGGElement>(`g[data-component-id="${cssEscape(id)}"]`);
      if (g) g.style.transform = `translate(${dx}px, ${dy}px)`;
    });

    // 2) Rewrite every affected wire path in place. Both underlay and
    //    stroke carry matching data-* -- we select both by [data-net].
    //    A stub attached to a moving component gets its pin end shifted
    //    by (dx, dy). Trunks are redrawn as a straight horizontal line
    //    at the median of the (now offset) pin ys of the net's pins.
    state.netsTouched.forEach((netId) => {
      // Collect all pin-ys for this net across the CURRENT rendered
      // schematic. For each pin, if its owning component is being
      // dragged, offset it by (dx, dy); otherwise use the stored pin
      // coords stamped on the corresponding stub path.
      const stubs = svg.querySelectorAll<SVGPathElement>(
        `path[data-net="${cssEscape(netId)}"][data-kind="stub"]`,
      );
      const stubMeta: Array<{ el: SVGPathElement; px: number; py: number; moving: boolean }> = [];
      stubs.forEach((el) => {
        const px = Number(el.getAttribute("data-pin-x")) || 0;
        const py = Number(el.getAttribute("data-pin-y")) || 0;
        const comp = el.getAttribute("data-comp") || "";
        stubMeta.push({ el, px, py, moving: state.ids.has(comp) });
      });
      // Deduplicate by (px, py, moving) -- underlay + stroke are siblings
      // with the same coords -- to compute trunk y off unique pins only.
      const uniquePinYs: number[] = [];
      const seen = new Set<string>();
      stubMeta.forEach((m) => {
        const effY = m.moving ? m.py + dy : m.py;
        const key = `${m.moving ? m.px + dx : m.px}:${effY}`;
        if (seen.has(key)) return;
        seen.add(key);
        uniquePinYs.push(effY);
      });
      uniquePinYs.sort((a, b) => a - b);
      const trunkYNow = uniquePinYs[Math.floor(uniquePinYs.length / 2)] ?? 0;

      // Trunk paths: rewrite to a single straight line spanning the min..max x.
      const uniquePinXs: number[] = [];
      const seenX = new Set<string>();
      stubMeta.forEach((m) => {
        const x = m.moving ? m.px + dx : m.px;
        const key = String(x);
        if (seenX.has(key)) return;
        seenX.add(key);
        uniquePinXs.push(x);
      });
      const minX = uniquePinXs.length ? Math.min(...uniquePinXs) : 0;
      const maxX = uniquePinXs.length ? Math.max(...uniquePinXs) : 0;

      const trunks = svg.querySelectorAll<SVGPathElement>(
        `path[data-net="${cssEscape(netId)}"][data-kind="trunk"]`,
      );
      trunks.forEach((el) => {
        el.setAttribute("d", `M${minX} ${trunkYNow} L${maxX} ${trunkYNow}`);
      });

      // Stubs: rewrite each to a straight line from its pin end (offset if
      // moving) to (pinX, trunkY). The stroke and underlay both need the
      // same d, so we rewrite them uniformly.
      stubMeta.forEach((m) => {
        const px = m.moving ? m.px + dx : m.px;
        const py = m.moving ? m.py + dy : m.py;
        m.el.setAttribute("d", `M${px} ${py} L${px} ${trunkYNow}`);
      });
    });
  }, []);

  const scheduleRaf = useCallback(() => {
    const state = dragRef.current;
    if (!state) return;
    if ("rafScheduled" in state && state.rafScheduled) return;
    if ("rafScheduled" in state) state.rafScheduled = true;
    requestAnimationFrame(() => {
      const s = dragRef.current;
      if (s && "rafScheduled" in s) s.rafScheduled = false;
      applyDragToDom();
    });
  }, [applyDragToDom]);

  // ---- pointer-down on a component: begin a component drag if selected
  const onComponentPointerDown = useCallback(
    (id: string, event: React.PointerEvent<SVGGElement>) => {
      if (!interactive) return;
      if (event.button !== 0) return;
      // Determine the selection set that will move. If the pointer-down
      // component is NOT already in the selection, replace the selection
      // with just this component before the drag starts.
      const current = useSchematicUI.getState().selectedComponents;
      let movingIds = new Set(current);
      if (!current.has(id)) {
        if (event.shiftKey) {
          // Shift-click on unselected -> add to selection and begin drag.
          movingIds = new Set(current);
          movingIds.add(id);
        } else {
          movingIds = new Set([id]);
        }
        replaceComponentSelection([...movingIds]);
      }
      // Capture pointer to the SVG so the drag survives pointer moves that
      // exit the component's rect and pointer-up outside the SVG.
      const svg = svgRef.current;
      if (!svg) return;
      try {
        svg.setPointerCapture(event.pointerId);
      } catch {
        // ignore -- browsers throw if pointer is already captured elsewhere
      }
      const start = svgClientToUser(event);
      // Precompute nets touched by this drag (union of nets on any moving
      // component's pins) so the pointerMove hot path can skip a search.
      const netsTouched = new Set<string>();
      const ir = schematicRef.current;
      ir?.components.forEach((c) => {
        if (!movingIds.has(c.id)) return;
        c.pins.forEach((pin) => {
          if (pin.net) netsTouched.add(pin.net);
        });
      });
      dragRef.current = {
        kind: "component",
        ids: movingIds,
        startX: start.x,
        startY: start.y,
        pendingDx: 0,
        pendingDy: 0,
        rafScheduled: false,
        lastAppliedDx: 0,
        lastAppliedDy: 0,
        netsTouched,
      };
      beginDrag([...movingIds]);
      event.stopPropagation();
      event.preventDefault();
    },
    [beginDrag, interactive, replaceComponentSelection],
  );

  // ---- pointer-down on the SVG background: begin a marquee OR clear
  const onSvgPointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!interactive) return;
      if (event.button !== 0) return;
      // Only treat this as a background press when the actual target is
      // the SVG itself or the background <rect>. Otherwise a component
      // handler will fire and set the drag state first.
      const target = event.target as Element | null;
      if (!target) return;
      const isBackground =
        target.tagName === "svg" ||
        target.getAttribute("data-role") === "canvas-bg";
      if (!isBackground) return;
      const svg = svgRef.current;
      if (!svg) return;
      try {
        svg.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      const start = svgClientToUser(event);
      dragRef.current = {
        kind: "marquee",
        shift: event.shiftKey,
        startX: start.x,
        startY: start.y,
        curX: start.x,
        curY: start.y,
      };
      const rectEl = marqueeRectRef.current;
      if (rectEl) {
        rectEl.setAttribute("x", String(start.x));
        rectEl.setAttribute("y", String(start.y));
        rectEl.setAttribute("width", "0");
        rectEl.setAttribute("height", "0");
        rectEl.style.display = "block";
      }
    },
    [interactive],
  );

  const onSvgPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const state = dragRef.current;
      if (!state) return;
      const p = svgClientToUser(event);
      if (state.kind === "component") {
        state.pendingDx = p.x - state.startX;
        state.pendingDy = p.y - state.startY;
      } else {
        state.curX = p.x;
        state.curY = p.y;
      }
      scheduleRaf();
    },
    [scheduleRaf],
  );

  const rollbackDom = useCallback((ids: Iterable<string>, netsTouched: Iterable<string>) => {
    const svg = svgRef.current;
    if (!svg) return;
    for (const id of ids) {
      const g = svg.querySelector<SVGGElement>(`g[data-component-id="${cssEscape(id)}"]`);
      if (g) g.style.transform = "";
    }
    for (const netId of netsTouched) {
      const paths = svg.querySelectorAll<SVGPathElement>(`path[data-net="${cssEscape(netId)}"]`);
      // The `d` attribute lives in React state -- forcing a React re-layout
      // by nulling the transform above isn't enough because we also rewrote
      // path `d`. So we manually restore each stub/trunk to its
      // last-rendered React value by re-reading its data-* + using stored
      // originals. In practice the next state re-render (either from
      // setUserXml on a fresh layout, or from any subsequent props change)
      // will overwrite these. For a failed drop we just force a re-render
      // via the schematic state update below.
      void paths;
    }
    // Force a React re-render to restore React-owned `d` values.
    setSchematic((s) => (s ? { ...s } : s));
  }, []);

  const onSvgPointerUp = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const state = dragRef.current;
      if (!state) return;
      const svg = svgRef.current;
      if (svg) {
        try {
          svg.releasePointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
      if (state.kind === "marquee") {
        // Compute the marquee rectangle in user coords, intersect with the
        // rendered component centres, and either replace the selection or
        // (with Shift held) add to it.
        const ir = schematicRef.current;
        const rectEl = marqueeRectRef.current;
        if (rectEl) rectEl.style.display = "none";
        if (ir) {
          const x0 = Math.min(state.startX, state.curX);
          const y0 = Math.min(state.startY, state.curY);
          const x1 = Math.max(state.startX, state.curX);
          const y1 = Math.max(state.startY, state.curY);
          // A near-zero marquee is a click -> clear (unless shift).
          const isClick = x1 - x0 < 3 && y1 - y0 < 3;
          if (isClick) {
            if (!state.shift) clear();
          } else {
            const inside = ir.components
              .filter((c) => c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1)
              .map((c) => c.id);
            if (state.shift) {
              const merged = new Set(useSchematicUI.getState().selectedComponents);
              inside.forEach((id) => merged.add(id));
              replaceComponentSelection([...merged]);
            } else {
              replaceComponentSelection(inside);
            }
          }
        }
        dragRef.current = null;
        return;
      }
      // component drop -- commit one <patch> with all moves.
      const dx = snapDrag(state.pendingDx);
      const dy = snapDrag(state.pendingDy);
      const movingIds = [...state.ids];
      const netsTouched = new Set(state.netsTouched);
      dragRef.current = null;
      endDrag();
      if (dx === 0 && dy === 0) {
        // No net movement -- reset transforms and leave XML alone.
        movingIds.forEach((id) => {
          const g = svg?.querySelector<SVGGElement>(`g[data-component-id="${cssEscape(id)}"]`);
          if (g) g.style.transform = "";
        });
        // Force a re-render to restore React-owned wire `d` values that our
        // pointer-move handler mutated in-place.
        setSchematic((s) => (s ? { ...s } : s));
        return;
      }
      const commit = onCommitMoveRef.current;
      const ir = schematicRef.current;
      if (!commit || !ir) {
        rollbackDom(movingIds, netsTouched);
        return;
      }
      const moves = movingIds
        .map((id) => {
          const placed = ir.components.find((c) => c.id === id);
          if (!placed) return null;
          return {
            id,
            x: snapDrag(placed.x + dx),
            y: snapDrag(placed.y + dy),
          };
        })
        .filter((m): m is { id: string; x: number; y: number } => m !== null);
      const result = commit(moves);
      if (!result.ok) {
        console.warn("Drag commit rejected:", result.message);
        rollbackDom(movingIds, netsTouched);
      }
      // On success, the design-store update will re-run buildSchematic
      // via the parent's `hints` prop update; that fresh state will
      // overwrite our DOM mutations naturally.
    },
    [clear, endDrag, replaceComponentSelection, rollbackDom],
  );

  const onSvgPointerCancel = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const state = dragRef.current;
    if (!state) return;
    const svg = svgRef.current;
    if (svg) {
      try {
        svg.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
    if (state.kind === "component") {
      const ids = [...state.ids];
      dragRef.current = null;
      endDrag();
      rollbackDom(ids, state.netsTouched);
    } else {
      const rectEl = marqueeRectRef.current;
      if (rectEl) rectEl.style.display = "none";
      dragRef.current = null;
    }
  }, [endDrag, rollbackDom]);

  const backgroundClick = interactive
    ? (event: React.MouseEvent<SVGSVGElement>) => {
        // If a drag was just released the pointerup handler above already
        // ran; this click either follows a genuine background click or a
        // marquee release that intentionally left the selection alone.
        const target = event.target as Element | null;
        if (!target) return;
        const isBackground =
          target.tagName === "svg" ||
          target.getAttribute("data-role") === "canvas-bg";
        if (!isBackground) return;
        if (event.shiftKey) return; // don't clear on shift+background click
        clear();
      }
    : undefined;

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
          ref={svgRef}
          className="native-schematic"
          viewBox={`0 0 ${schematic.width} ${schematic.height}`}
          role="img"
          aria-label="AIR schematic"
          onClick={backgroundClick}
          onPointerDown={interactive ? onSvgPointerDown : undefined}
          onPointerMove={interactive ? onSvgPointerMove : undefined}
          onPointerUp={interactive ? onSvgPointerUp : undefined}
          onPointerCancel={interactive ? onSvgPointerCancel : undefined}
          data-testid="schematic-svg"
        >
          <defs>
            <pattern id="schematic-grid" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
              <path d={`M${GRID} 0H0V${GRID}`} fill="none" stroke="#e4e9f1" strokeWidth="1" />
            </pattern>
          </defs>
          <rect
            width="100%"
            height="100%"
            fill="url(#schematic-grid)"
            data-role="canvas-bg"
          />
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
              const isSelected = compSelected(component.id);
              const props: {
                component: typeof component;
                selected?: boolean;
                highlightedNets?: Set<string>;
                onSelect?: (shift: boolean) => void;
                onPointerDown?: (event: React.PointerEvent<SVGGElement>) => void;
              } = { component };
              if (interactive) {
                props.selected = isSelected;
                props.highlightedNets = highlightedNets;
                props.onSelect = (shift: boolean) => {
                  if (shift) toggleComponent(component.id);
                  else selectComponent(component.id);
                };
                props.onPointerDown = (event) => onComponentPointerDown(component.id, event);
              }
              return <ComponentSvg key={component.id} {...props} />;
            })}
          </g>
          {interactive && (
            <rect
              ref={marqueeRectRef}
              className="schematic-marquee"
              x={0}
              y={0}
              width={0}
              height={0}
              style={{ display: "none" }}
              pointerEvents="none"
            />
          )}
        </svg>
      ) : (
        <div className="schematic-loading">Laying out schematic…</div>
      )}
    </div>
  );
};

/**
 * CSS.escape polyfill for querySelector attribute values (component ids
 * may contain characters that need escaping in a selector). Node 20+
 * ships CSS.escape but we're conservative.
 */
function cssEscape(value: string): string {
  if (typeof (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape === "function") {
    return (globalThis as { CSS: { escape: (v: string) => string } }).CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

export default Renderer;
export type { Selection };
