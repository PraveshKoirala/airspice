/**
 * Schematic interaction store (issue #22 refactor + selection + issue #23 drag).
 *
 * Owns:
 *   - currently selected component(s) or net,
 *   - live transform-layer preview offsets during a drag (issue #23 perf
 *     invariant: NO XML writes and NO layout re-runs happen during pointer
 *     move; only these offsets change, then the Renderer's pointerMove uses
 *     them via a ref to update SVG transforms directly without React
 *     re-render).
 *
 * Selection is CLEARED on Escape (wired in Renderer.tsx) and on any click
 * that reaches the SVG background (which also stops propagation).
 *
 * Multi-select (issue #23):
 *   - a single click replaces the selection with just that component;
 *   - shift-click toggles a component in/out of the current selection;
 *   - a marquee drag on the background union-adds every component the
 *     rectangle intersects (shift held or not; a plain marquee replaces).
 *
 * Drag (issue #23):
 *   - `dragOffsets` is a Map<id, {dx,dy}> that describes the CURRENT
 *     transform-layer offset for every dragging component. It is committed
 *     to the XML as a single `<patch>` on drop and CLEARED here.
 *   - `dragActive` is `true` while a pointer is captured; the Renderer
 *     reads it to know whether to draw straight-line wire previews.
 */

import { create } from "zustand";

export type SelectionKind = "component" | "net";

/**
 * Drag/nudge grid pitch, in schematic user units. Issue #23 acceptance:
 * "10px grid snap; no un-snapped positions may enter the XML". This is the
 * SINGLE source of truth for drag/nudge snapping; the drop path and the
 * keyboard-nudge path both call `snapDrag`. It is deliberately finer than
 * the auto-layout lattice (GRID=24) so a user can nudge a component into a
 * position ELK would never pick.
 */
export const DRAG_GRID = 10;
export const snapDrag = (value: number): number =>
  Math.round(value / DRAG_GRID) * DRAG_GRID;

export interface Selection {
  kind: SelectionKind;
  id: string;
}

/**
 * Public state. Legacy readers (Inspector, tests) still consume
 * `selection` in its original {kind,id} shape when there is exactly one
 * item selected; multi-select components appear in `selectedComponents`.
 * A net selection is always single (nets are not multi-selectable in #23).
 */
export interface SchematicUIState {
  /** Convenience: the single-selection projection. `null` when zero or many. */
  selection: Selection | null;
  /** The full component multi-selection. Empty when a net is selected. */
  selectedComponents: Set<string>;
  /** The selected net (single). `null` when a component or nothing is selected. */
  selectedNet: string | null;

  /** Live drag offsets, keyed by component id. Snapped to `DRAG_GRID`. */
  dragOffsets: Map<string, { dx: number; dy: number }>;
  /** `true` between beginDrag and endDrag; drives straight-line wire preview. */
  dragActive: boolean;

  selectComponent: (id: string) => void;
  toggleComponent: (id: string) => void;
  replaceComponentSelection: (ids: string[]) => void;
  selectNet: (id: string) => void;
  clear: () => void;

  beginDrag: (ids: string[]) => void;
  setDragOffset: (dx: number, dy: number) => void;
  endDrag: () => void;
}

function projectSingle(selectedComponents: Set<string>, selectedNet: string | null): Selection | null {
  if (selectedNet) return { kind: "net", id: selectedNet };
  if (selectedComponents.size === 1) {
    const [only] = selectedComponents;
    return { kind: "component", id: only! };
  }
  return null;
}

export const useSchematicUI = create<SchematicUIState>((set, get) => ({
  selection: null,
  selectedComponents: new Set<string>(),
  selectedNet: null,
  dragOffsets: new Map<string, { dx: number; dy: number }>(),
  dragActive: false,

  selectComponent: (id) => {
    const next = new Set<string>([id]);
    set({
      selectedComponents: next,
      selectedNet: null,
      selection: projectSingle(next, null),
    });
  },
  toggleComponent: (id) => {
    const next = new Set(get().selectedComponents);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({
      selectedComponents: next,
      selectedNet: null,
      selection: projectSingle(next, null),
    });
  },
  replaceComponentSelection: (ids) => {
    const next = new Set(ids);
    set({
      selectedComponents: next,
      selectedNet: null,
      selection: projectSingle(next, null),
    });
  },
  selectNet: (id) => {
    const next = new Set<string>();
    set({
      selectedComponents: next,
      selectedNet: id,
      selection: projectSingle(next, id),
    });
  },
  clear: () =>
    set({
      selectedComponents: new Set<string>(),
      selectedNet: null,
      selection: null,
      dragOffsets: new Map<string, { dx: number; dy: number }>(),
      dragActive: false,
    }),

  beginDrag: (ids) => {
    const offsets = new Map<string, { dx: number; dy: number }>();
    ids.forEach((id) => offsets.set(id, { dx: 0, dy: 0 }));
    set({ dragOffsets: offsets, dragActive: true });
  },
  setDragOffset: (dx, dy) => {
    const snappedDx = snapDrag(dx);
    const snappedDy = snapDrag(dy);
    const ids = [...get().dragOffsets.keys()];
    const next = new Map<string, { dx: number; dy: number }>();
    ids.forEach((id) => next.set(id, { dx: snappedDx, dy: snappedDy }));
    set({ dragOffsets: next });
  },
  endDrag: () => {
    set({
      dragOffsets: new Map<string, { dx: number; dy: number }>(),
      dragActive: false,
    });
  },
}));

/** Non-reactive snapshot (mirrors designStore's snapshot pattern). */
export function selectionSnapshot(): Selection | null {
  return useSchematicUI.getState().selection;
}
