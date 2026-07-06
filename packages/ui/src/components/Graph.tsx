/**
 * Thin compatibility shim for the schematic Renderer (issue #22 refactor).
 *
 * The 30KB monolith that used to live here has been split into
 * `packages/ui/src/schematic/{types.ts, layout.ts, symbols.tsx,
 * interaction.ts, Renderer.tsx}`. This file is preserved as the import
 * surface used by App.tsx so the refactor is a pure package split -- the
 * DOM output is byte-identical to the pre-refactor build for hint-less
 * designs (verified by scripts/schematic-parity).
 *
 * New callers should import `Renderer` from `../schematic/Renderer`
 * directly; keeping this shim avoids churn on unrelated diffs.
 */

import React from "react";
import type { Edge, Node } from "reactflow";
import Renderer from "../schematic/Renderer";
import type { GuiHint, SchematicIR } from "../schematic/types";

export interface GraphProps {
  nodes: Node[];
  edges: Edge[];
  /** `<gui>` position hints (issue #22 B). Empty by default. */
  hints?: GuiHint[];
  /** Enable click-to-select + Escape-to-clear (issue #22 C). */
  interactive?: boolean;
  /** Fires with the placed IR after each successful layout (issue #22 "Save layout"). */
  onLayout?: (ir: SchematicIR) => void;
}

const Graph: React.FC<GraphProps> = (props) => <Renderer {...props} />;

export default Graph;

// Re-exports so the parity snapshot script and any downstream consumer keep
// working. The temporary `buildSchematic` export at the bottom of the
// pre-refactor Graph.tsx is now re-exported from schematic/layout.ts.
export { buildSchematic } from "../schematic/layout";
export type { SchematicIR } from "../schematic/types";
