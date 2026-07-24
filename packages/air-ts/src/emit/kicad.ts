/**
 * KiCad 8 (.kicad_sch) schematic emitter for SystemIR (Milestone M7, issue #34).
 *
 * Emits a WELL-FORMED, self-contained KiCad 8 schematic — not a token stub:
 *
 *  - `lib_symbols`: every component gets a real embedded symbol definition
 *    (rectangle body + one KiCad `pin` per AIR pin), so the file OPENS and
 *    RENDERS in KiCad with no "missing symbol / rescue" prompts. Symbols are
 *    deduped by (type, pin-name-set) signature.
 *  - Symbol INSTANCES carry `(lib_id …)`, `Reference`/`Value` properties, a
 *    stable `uuid`, and the KiCad-8 `(instances (project …))` block.
 *  - CONNECTIVITY: each pin's connection point gets a coincident local `label`
 *    carrying the AIR net id. KiCad nets pins that share a label name on a
 *    sheet, so the exported schematic reproduces the AIR netlist. Label
 *    positions use KiCad's symbol-Y-up → sheet-Y-down transform.
 *  - Deterministic output: layout is a fixed grid and every `uuid` is derived
 *    from a stable key (FNV-1a), so the same design always emits byte-identical
 *    text — the export is diffable and testable.
 *
 * S-expression escaping is applied to every user string; the emitter guarantees
 * balanced parentheses (asserted by the M7 test).
 */
import type { SystemIR, Component } from "../model.js";

export interface KicadExportResult {
  /** The .kicad_sch document text. */
  text: string;
  /** Number of symbol instances emitted (== component count). */
  symbols: number;
  /** Number of distinct nets emitted as labels. */
  nets: number;
  /** Number of pin→net labels emitted. */
  pins: number;
}

// --- geometry (millimetres, KiCad's schematic unit) -------------------------- //
const GRID_COLS = 6;
const COL_SPACING = 38.1;
const ROW_SPACING = 27.94;
const MARGIN = 25.4;
const PIN_X = -12.7; // pin connection point, left of the body
const PIN_LENGTH = 7.62;
const PIN_STEP = 2.54;
const BODY_HALF_W = 5.08;
const SHEET_UUID = "a1r5p1ce-0000-4000-8000-000000000001";

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic RFC-4122-shaped uuid derived from a stable key. */
function detUuid(key: string): string {
  const h = (salt: string) => fnv1a(`${key}#${salt}`).toString(16).padStart(8, "0");
  const a = h("a");
  const b = h("b");
  const c = h("c");
  const d = h("d");
  return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4, 8)}${d}`;
}

/** Escape a string for a KiCad quoted S-expression atom. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

interface PinLayout {
  name: string;
  /** connection point in symbol-local coords (Y up). */
  lx: number;
  ly: number;
}

/** Lay a component's pins out along the left edge, centred vertically. */
function pinLayout(pinNames: string[]): PinLayout[] {
  const n = pinNames.length;
  const topY = ((n - 1) / 2) * PIN_STEP;
  return pinNames.map((name, i) => ({ name, lx: PIN_X, ly: topY - i * PIN_STEP }));
}

function bodyHalfHeight(n: number): number {
  return Math.max(5.08, (n * PIN_STEP) / 2 + 2.54);
}

/** Signature that determines whether two components can share a lib_symbol. */
function signature(c: Component): string {
  return `${c.type}|${[...c.pins.values()].map((p) => p.name).join(",")}`;
}

function symbolLibId(type: string, index: number): string {
  return index === 0 ? `AirSpice:${type}` : `AirSpice:${type}_${index}`;
}

export function exportKicad(ir: SystemIR): KicadExportResult {
  const titleStr =
    ir.metadata && ir.metadata.title ? ir.metadata.title : ir.name || "AirSpice Design";

  // 1) Assign each component a deduped lib_symbol id by signature.
  const sigToLibId = new Map<string, string>();
  const libDefs: string[] = [];
  const typeCounts = new Map<string, number>();
  const componentLibId = new Map<string, string>();

  for (const comp of ir.components.values()) {
    const sig = signature(comp);
    let libId = sigToLibId.get(sig);
    if (libId === undefined) {
      const idx = typeCounts.get(comp.type) ?? 0;
      typeCounts.set(comp.type, idx + 1);
      libId = symbolLibId(comp.type, idx);
      sigToLibId.set(sig, libId);
      libDefs.push(renderLibSymbol(libId, [...comp.pins.values()].map((p) => p.name)));
    }
    componentLibId.set(comp.id, libId);
  }

  // 2) Place instances on a grid; record absolute pin positions for labels.
  const instanceBlocks: string[] = [];
  const labelBlocks: string[] = [];
  const netSet = new Set<string>();
  let pinLabelCount = 0;
  let i = 0;

  for (const comp of ir.components.values()) {
    const col = i % GRID_COLS;
    const row = Math.floor(i / GRID_COLS);
    const ox = MARGIN + col * COL_SPACING;
    const oy = MARGIN + row * ROW_SPACING;
    i++;

    const libId = componentLibId.get(comp.id)!;
    const pins = [...comp.pins.values()];
    const layout = pinLayout(pins.map((p) => p.name));
    const halfH = bodyHalfHeight(pins.length);
    const refVal = comp.value || comp.part || comp.type;

    instanceBlocks.push(
      renderInstance(libId, comp.id, refVal, ox, oy, halfH),
    );

    for (let k = 0; k < pins.length; k++) {
      const pin = pins[k]!;
      const lay = layout[k]!;
      // symbol-local (Y up) -> sheet (Y down): sheetY = oy - ly
      const lx = ox + lay.lx;
      const ly = oy - lay.ly;
      netSet.add(pin.net);
      pinLabelCount++;
      labelBlocks.push(
        `  (label "${esc(pin.net)}" (at ${fmt(lx)} ${fmt(ly)} 0)\n` +
          `    (effects (font (size 1.27 1.27)) (justify left bottom))\n` +
          `    (uuid "${detUuid(`label:${comp.id}:${pin.name}`)}")\n` +
          `  )`,
      );
    }
  }

  const doc: string[] = [
    '(kicad_sch (version 20231120) (generator "airspice-air-ts")',
    `  (uuid "${SHEET_UUID}")`,
    '  (paper "A4")',
    "  (title_block",
    `    (title "${esc(titleStr)}")`,
    '    (comment 1 "Generated by AirSpice air-ts KiCad exporter (M7)")',
    "  )",
    "  (lib_symbols",
    ...libDefs,
    "  )",
    ...instanceBlocks,
    ...labelBlocks,
    ")",
    "",
  ];

  return {
    text: doc.join("\n"),
    symbols: ir.components.size,
    nets: netSet.size,
    pins: pinLabelCount,
  };
}

function fmt(n: number): string {
  // KiCad tolerates decimals; keep them short + deterministic.
  return (Math.round(n * 100) / 100).toString();
}

function renderLibSymbol(libId: string, pinNames: string[]): string {
  const n = pinNames.length;
  const halfH = bodyHalfHeight(n);
  const layout = pinLayout(pinNames);
  const bare = libId.split(":")[1] ?? libId;

  const pinSexprs = layout
    .map(
      (lay) =>
        `      (pin passive line (at ${fmt(lay.lx)} ${fmt(lay.ly)} 0) (length ${fmt(PIN_LENGTH)})\n` +
        `        (name "${esc(lay.name)}" (effects (font (size 1.27 1.27))))\n` +
        `        (number "${esc(lay.name)}" (effects (font (size 1.27 1.27))))\n` +
        `      )`,
    )
    .join("\n");

  return (
    `    (symbol "${esc(libId)}" (pin_names (offset 0.254)) (in_bom yes) (on_board yes)\n` +
    `      (property "Reference" "U" (at 0 ${fmt(halfH + 2.54)} 0) (effects (font (size 1.27 1.27))))\n` +
    `      (property "Value" "${esc(bare)}" (at 0 ${fmt(-halfH - 2.54)} 0) (effects (font (size 1.27 1.27))))\n` +
    `      (symbol "${esc(bare)}_0_1"\n` +
    `        (rectangle (start ${fmt(-BODY_HALF_W)} ${fmt(halfH)}) (end ${fmt(BODY_HALF_W)} ${fmt(-halfH)})\n` +
    `          (stroke (width 0.254) (type default)) (fill (type none)))\n` +
    `      )\n` +
    `      (symbol "${esc(bare)}_1_1"\n` +
    pinSexprs +
    `\n      )\n` +
    `    )`
  );
}

function renderInstance(
  libId: string,
  reference: string,
  value: string,
  ox: number,
  oy: number,
  halfH: number,
): string {
  return (
    `  (symbol (lib_id "${esc(libId)}") (at ${fmt(ox)} ${fmt(oy)} 0) (unit 1)\n` +
    `    (in_bom yes) (on_board yes)\n` +
    `    (uuid "${detUuid(`inst:${reference}`)}")\n` +
    `    (property "Reference" "${esc(reference)}" (at ${fmt(ox)} ${fmt(oy - halfH - 2.54)} 0)\n` +
    `      (effects (font (size 1.27 1.27))))\n` +
    `    (property "Value" "${esc(value)}" (at ${fmt(ox)} ${fmt(oy + halfH + 2.54)} 0)\n` +
    `      (effects (font (size 1.27 1.27))))\n` +
    `    (instances (project "AirSpice" (path "/${SHEET_UUID}" (reference "${esc(reference)}") (unit 1))))\n` +
    `  )`
  );
}

/**
 * Emit a SystemIR as a KiCad 8 schematic string. Backwards-compatible facade
 * over {@link exportKicad}; callers wanting structural counts use exportKicad.
 */
export function emitKicadSchematic(ir: SystemIR): string {
  return exportKicad(ir).text;
}
