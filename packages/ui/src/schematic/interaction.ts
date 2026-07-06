/**
 * Schematic interaction store (issue #22 refactor + selection).
 *
 * Owns the currently selected component or net so the Renderer, Inspector,
 * and any future interaction layer (drag-to-move, wiring) can all read the
 * same source of truth. Selection is UI-only state -- the design XML is
 * unchanged by selecting or deselecting -- so it lives in a Zustand store
 * SEPARATE from the design store (which owns the XML and the version).
 *
 * Kinds:
 *   - "component": id refers to a <component id="...">
 *   - "net":       id refers to a <net id="...">
 *
 * Selection is CLEARED on Escape (wired in Renderer.tsx) and on any click
 * that reaches the canvas background (which also stops propagation).
 */

import { create } from "zustand";

export type SelectionKind = "component" | "net";

export interface Selection {
  kind: SelectionKind;
  id: string;
}

export interface SchematicUIState {
  selection: Selection | null;
  selectComponent: (id: string) => void;
  selectNet: (id: string) => void;
  clear: () => void;
}

export const useSchematicUI = create<SchematicUIState>((set) => ({
  selection: null,
  selectComponent: (id) => set({ selection: { kind: "component", id } }),
  selectNet: (id) => set({ selection: { kind: "net", id } }),
  clear: () => set({ selection: null }),
}));

/** Non-reactive snapshot (mirrors designStore's snapshot pattern). */
export function selectionSnapshot(): Selection | null {
  return useSchematicUI.getState().selection;
}
