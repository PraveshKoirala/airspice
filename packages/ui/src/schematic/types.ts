/**
 * Shared types for the schematic package (issue #22 refactor).
 *
 * These interfaces used to live at the top of components/Graph.tsx. Moving
 * them here means layout.ts, symbols.tsx, Renderer.tsx, and interaction.ts
 * all consume the same shapes without importing each other transitively.
 * PARITY: field names and roles are unchanged from the monolith, so the
 * refactor is behavior-neutral -- verified by scripts/schematic-parity.
 */

export type Pin = {
  name: string;
  net: string;
  function?: string;
};

export type Point = {
  x: number;
  y: number;
};

export type NetRole = "power" | "ground" | "signal";

export type Orientation = "horizontal" | "vertical";

export type SchematicComponent = {
  id: string;
  type: string;
  value: string;
  part: string;
  spiceModel: string;
  x: number;
  y: number;
  orientation: Orientation;
  labelSide?: "left" | "right";
  pins: Pin[];
};

export type PinPoint = Point & {
  component: string;
  pin: string;
  net: string;
};

export type NetShape = {
  id: string;
  role: NetRole;
  label: string;
  laneY?: number;
  trunkY?: number;
  labelX?: number;
  points: PinPoint[];
};

export type SchematicIR = {
  components: SchematicComponent[];
  nets: NetShape[];
  width: number;
  height: number;
};

/**
 * Optional GUI layout hint on a component (issue #22 B). Parsed from the
 * `<gui x=".." y=".." rot=".."/>` child in the design XML by air-ts. When
 * present, layoutComponents uses these exact coordinates instead of running
 * ELK for that component. Rot is degrees (0/90/180/270).
 */
export type GuiHint = {
  componentId: string;
  x: number;
  y: number;
  rot: number;
};
