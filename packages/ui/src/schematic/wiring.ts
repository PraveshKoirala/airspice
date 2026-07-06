/**
 * Wiring, palette, and delete patch builders (issue #24 D1-D4).
 *
 * All builders return an XML `<patch>` string. They are pure -- they read
 * the parsed IR they were passed and hand a well-formed patch back to the
 * caller. The caller (Renderer / Palette / Inspector) is responsible for
 * running the patch through the gate via schematic/gate.ts.
 *
 * PARITY (issue #24 disconnect, "orphaned single-pin nets pruned"):
 *
 * The issue asks us to "mirror the Python canonicalizer's pruning behavior"
 * -- but there is no such behavior. We verified by reading
 * `packages/core/src/air/canonicalizer.py` (revision 68507ec+): the module
 * ONLY sorts attributes, reorders top-level sections by SECTION_ORDER,
 * sorts id-bearing children by id, and reorders <gui> to its slot. It does
 * NOT remove nets, orphaned or otherwise. `packages/air-ts/src/normalizer.ts`
 * likewise does not prune.
 *
 * Consequently the pruning here is a UI-SIDE CONVENIENCE. It is triggered
 * ONLY by disconnect (removePinFromNet): when the last pin is removed, the
 * <net> element is removed in the SAME patch. This keeps the design tidy
 * for the user (no dangling "n17" nets in the palette or the sidebar) but
 * does NOT retroactively canonicalize any imported design. Nothing else in
 * the pipeline depends on this pruning.
 */

import type { SystemIR } from "air-ts";
import type { ComponentSpec } from "air-ts";
import type { GuiHint } from "./types";
import {
  serializeComponentBody,
  xmlEscape,
  type ParsedComponent,
} from "./patches";

/**
 * Build the next available auto-net id that does NOT collide with any
 * existing net in the parsed IR (or with any name already reserved by an
 * earlier op in the same batch). Format: n1, n2, ... The issue acceptance
 * criterion specifically calls out "test with a design already containing
 * n1", which is why we walk the existing set explicitly instead of
 * committing to `n{count+1}`.
 */
export function nextAutoNetId(
  parsed: SystemIR,
  reserved: ReadonlySet<string> = new Set(),
): string {
  let i = 1;
  while (parsed.nets.has(`n${i}`) || reserved.has(`n${i}`)) i++;
  return `n${i}`;
}

/**
 * Per-type fresh id counter for palette placement (R1, R2, ..., C1, C2,
 * ..., V1, U1, ...). Mirrors the "one letter per component type" convention
 * every AIR sample uses. Falls back to the type prefix (uppercased, up to 3
 * chars) for uncommon types.
 */
const TYPE_PREFIX: Record<string, string> = {
  resistor: "R",
  capacitor: "C",
  voltage_source: "V",
  current_source: "I",
  generic_load: "L",
  ldo: "U",
  mosfet: "M",
  diode: "D",
  bjt: "Q",
  mcu: "U",
  sensor: "S",
  battery: "B",
};

export function componentIdPrefix(type: string): string {
  const p = TYPE_PREFIX[type];
  if (p) return p;
  return type.slice(0, 3).toUpperCase() || "X";
}

export function nextComponentId(
  parsed: SystemIR,
  type: string,
  reserved: ReadonlySet<string> = new Set(),
): string {
  const prefix = componentIdPrefix(type);
  let i = 1;
  while (parsed.components.has(`${prefix}${i}`) || reserved.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/**
 * Build a `<patch>` that reassigns component `compId`'s pin `pinName` to a
 * different net (`newNetId`). Used both by "drop pin on existing net" and
 * by disconnect (net = "" is not allowed -- disconnect calls
 * `disconnectPinPatch` instead).
 *
 * This works by replacing the WHOLE component element (mirrors the pattern
 * used by Inspector for id/gui edits): we can't <replace path=".../pin[N]">
 * because pins index by name, not position, and there is no path syntax to
 * change an attribute of a leaf element without replacing the leaf.
 */
export function reassignPinPatch(
  comp: ParsedComponent,
  pinName: string,
  newNetId: string,
): string {
  const nextPins = new Map(comp.pins);
  const pin = nextPins.get(pinName);
  if (!pin) throw new Error(`unknown pin ${pinName} on ${comp.id}`);
  nextPins.set(pinName, { ...pin, net: newNetId });
  const nextComp: ParsedComponent = { ...comp, pins: nextPins };
  const { attrs, body } = serializeComponentBody(nextComp);
  const path = `components/component[@id='${comp.id}']`;
  return `<patch><replace path="${path}"><component ${attrs}>${body}</component></replace></patch>`;
}

/**
 * Build a `<patch>` that reassigns TWO pins (on possibly different
 * components) to a new net, AND adds that net to `<nets>`. This is the
 * pin-to-pin wiring case: both endpoints are currently on nets with no
 * other members, so the auto-name becomes their shared net.
 *
 * The new `<net>` element uses role="signal" by default; when either
 * endpoint was previously ground-typed we skip auto-name creation and
 * instead join the ground net at the callsite. `roleHint` is used only
 * when the new net is created.
 */
export function connectPinsWithNewNetPatch(
  a: { comp: ParsedComponent; pin: string },
  b: { comp: ParsedComponent; pin: string },
  newNetId: string,
  roleHint: "signal" | "power" | "ground" = "signal",
): string {
  const ops: string[] = [];
  ops.push(
    `<add path="nets"><net id="${xmlEscape(newNetId)}" role="${roleHint}"/></add>`,
  );
  ops.push(reassignOp(a.comp, a.pin, newNetId));
  if (b.comp.id === a.comp.id) {
    // Same component: build ONE replacement with both pins updated.
    const nextPins = new Map(a.comp.pins);
    const pinA = nextPins.get(a.pin);
    const pinB = nextPins.get(b.pin);
    if (!pinA || !pinB) throw new Error("pin lookup failed");
    nextPins.set(a.pin, { ...pinA, net: newNetId });
    nextPins.set(b.pin, { ...pinB, net: newNetId });
    const nextComp: ParsedComponent = { ...a.comp, pins: nextPins };
    const { attrs, body } = serializeComponentBody(nextComp);
    const path = `components/component[@id='${a.comp.id}']`;
    // Replace the earlier reassignOp for `a` with a single combined replace.
    ops.pop();
    ops.push(
      `<replace path="${path}"><component ${attrs}>${body}</component></replace>`,
    );
  } else {
    ops.push(reassignOp(b.comp, b.pin, newNetId));
  }
  return `<patch>${ops.join("")}</patch>`;
}

/** Bare `<replace>` op for a pin-net reassignment; concatenable into a batch. */
function reassignOp(
  comp: ParsedComponent,
  pinName: string,
  newNetId: string,
): string {
  const nextPins = new Map(comp.pins);
  const pin = nextPins.get(pinName);
  if (!pin) throw new Error(`unknown pin ${pinName} on ${comp.id}`);
  nextPins.set(pinName, { ...pin, net: newNetId });
  const nextComp: ParsedComponent = { ...comp, pins: nextPins };
  const { attrs, body } = serializeComponentBody(nextComp);
  const path = `components/component[@id='${comp.id}']`;
  return `<replace path="${path}"><component ${attrs}>${body}</component></replace>`;
}

/**
 * Build a `<patch>` that disconnects `pinName` from its current net. The
 * pin becomes a floating placeholder net (auto-named). This mirrors the
 * "delete wire segment" gesture: the pin doesn't vanish, but it stops
 * being connected to whatever else was on that net.
 *
 * If, after removal, the pin's OLD net has no other members, we prune the
 * <net> element in the same patch (see PARITY note at top of file).
 */
export function disconnectPinPatch(
  parsed: SystemIR,
  compId: string,
  pinName: string,
  floatingNetId: string,
): string {
  const comp = parsed.components.get(compId);
  if (!comp) throw new Error(`unknown component ${compId}`);
  const pin = comp.pins.get(pinName);
  if (!pin) throw new Error(`unknown pin ${pinName} on ${compId}`);
  const oldNet = pin.net;
  const ops: string[] = [];
  // 1) Rewrite the component so the pin points to a fresh floating net.
  ops.push(reassignOp(comp, pinName, floatingNetId));
  // 2) Add the floating net so the design remains structurally valid
  //    (signal role; role is inferred from the id by the normalizer but
  //    passing it explicitly avoids a warning-severity diagnostic).
  ops.push(
    `<add path="nets"><net id="${xmlEscape(floatingNetId)}" role="signal"/></add>`,
  );
  // 3) If the old net's remaining member count is zero after this move,
  //    prune it. Count members BEFORE the move; subtract 1 for the pin
  //    being moved away.
  const remaining = countPinsOnNet(parsed, oldNet) - 1;
  if (remaining <= 0 && parsed.nets.has(oldNet)) {
    ops.push(`<remove path="nets/net[@id='${oldNet}']"/>`);
  }
  return `<patch>${ops.join("")}</patch>`;
}

/**
 * Delete a whole wire (net): moves EVERY pin off the net onto its own
 * fresh floating net, then removes the net element. Used by
 * "select net -> Delete" when the user wants the connection gone
 * without deleting components.
 *
 * A net with 0 or 1 pin is removed outright (no reassignment needed).
 *
 * Only unrouted signal nets are safe to delete this way: power/ground
 * rails are structural. The Renderer restricts the Delete gesture to
 * non-rail nets before calling us; we cite that constraint here.
 */
export function deleteNetPatch(
  parsed: SystemIR,
  netId: string,
  autoNamer: (reserved: Set<string>) => string,
): string {
  const ops: string[] = [];
  const reserved = new Set<string>();
  for (const comp of parsed.components.values()) {
    for (const pin of comp.pins.values()) {
      if (pin.net !== netId) continue;
      const floating = autoNamer(reserved);
      reserved.add(floating);
      ops.push(reassignOp(comp, pin.name, floating));
      ops.push(
        `<add path="nets"><net id="${xmlEscape(floating)}" role="signal"/></add>`,
      );
    }
  }
  if (parsed.nets.has(netId)) {
    ops.push(`<remove path="nets/net[@id='${netId}']"/>`);
  }
  return `<patch>${ops.join("")}</patch>`;
}

function countPinsOnNet(parsed: SystemIR, netId: string): number {
  let n = 0;
  for (const comp of parsed.components.values()) {
    for (const pin of comp.pins.values()) {
      if (pin.net === netId) n++;
    }
  }
  return n;
}

// ------------------------------------------------------------------
// Component palette placement (issue #24 D3)
// ------------------------------------------------------------------

/** One entry in the palette listing. Built from air-ts's COMPONENT_SPECS. */
export interface PaletteEntry {
  type: string;
  displayName: string;
  requiredPins: string[];
  defaultValue: string;
  valueRequired: boolean;
  requiredProperties: string[];
}

/**
 * Reasonable default values for palette-placed components. Deliberately
 * simple -- the user's next step is usually to open the Inspector and set
 * the actual value, so these are chosen to be gate-clean rather than
 * useful. The gate would reject "0" for a resistor (must have a unit), so
 * we pick sample values from the corpus.
 */
const DEFAULT_VALUES: Record<string, string> = {
  resistor: "1k",
  capacitor: "100nF",
  voltage_source: "5V",
  current_source: "1mA",
  generic_load: "1k",
};

const DISPLAY_NAMES: Record<string, string> = {
  resistor: "Resistor",
  capacitor: "Capacitor",
  voltage_source: "Voltage source",
  current_source: "Current source",
  generic_load: "Generic load",
  ldo: "LDO regulator",
  mosfet: "MOSFET",
  diode: "Diode",
  bjt: "BJT",
  mcu: "MCU",
  sensor: "Sensor",
  battery: "Battery",
};

/**
 * Build the palette listing from air-ts's compiled COMPONENT_SPECS. This
 * is a PURE derivation of the compiled registry -- no fs, no fetch, and
 * fully bundled so the palette works with the backend off (issue #24
 * guardrail: zero-backend default).
 */
export function paletteEntries(
  componentSpecs: Record<string, ComponentSpec>,
): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const [type, spec] of Object.entries(componentSpecs)) {
    // Skip mcu/sensor unless they carry pins (they need a `part` -- placing
    // one from the palette without picking a specific chip would be
    // useless and would fail the gate). Everything else with pins ships.
    if (!spec.required_pins || spec.required_pins.length === 0) continue;
    out.push({
      type,
      displayName: DISPLAY_NAMES[type] || type,
      requiredPins: [...spec.required_pins],
      defaultValue: DEFAULT_VALUES[type] || "",
      valueRequired: spec.value_required === true,
      requiredProperties: spec.required_properties
        ? [...spec.required_properties]
        : [],
    });
  }
  // Deterministic order: alphabetical by type (matches the Python
  // registry's dict iteration when Python 3.7+ preserves insertion order --
  // which for the on-disk merge is filename order; alphabetical is stable).
  out.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return out;
}

/**
 * Build a `<patch>` that adds a fresh component of `entry.type` to the
 * design at cursor position `hint`. The component gets a fresh id
 * (`nextComponentId`), the palette's `defaultValue`, and one auto-named
 * floating net per required pin so the placed component is IMMEDIATELY
 * gate-clean (no dangling required pins).
 *
 * `hint` is a <gui> position hint so drop position is preserved on the
 * next layout pass.
 *
 * The palette does NOT try to auto-connect adjacent nets; wire drawing is
 * a separate gesture. This keeps the placement contract simple: click,
 * place, wire. LDO/MCU are omitted (they need required_properties or
 * a part= we can't fill in blindly).
 */
export function placeComponentPatch(
  parsed: SystemIR,
  entry: PaletteEntry,
  hint: GuiHint,
): { patchXml: string; newComponentId: string } {
  const compId = nextComponentId(parsed, entry.type);
  // Reserve enough auto-net ids for every required pin. The set contains
  // both the freshly-invented net ids AND any that appear earlier in this
  // batch, so we never emit duplicates.
  const reservedNets = new Set<string>();
  const pinNets: Record<string, string> = {};
  for (const pinName of entry.requiredPins) {
    const netId = nextAutoNetId(parsed, reservedNets);
    reservedNets.add(netId);
    pinNets[pinName] = netId;
  }

  // XML for the component: value (if any), pins, then <gui>. The
  // canonicalizer will move <gui> to its slot; we emit it up front so the
  // pre-canonical patch is still valid.
  const pinLines = entry.requiredPins
    .map((name) => `<pin name="${xmlEscape(name)}" net="${xmlEscape(pinNets[name]!)}"/>`)
    .join("");
  const valueLine =
    entry.valueRequired || entry.defaultValue
      ? `<value>${xmlEscape(entry.defaultValue)}</value>`
      : "";
  const guiLine = `<gui x="${hint.x}" y="${hint.y}" rot="${hint.rot}"/>`;
  const componentXml =
    `<component id="${xmlEscape(compId)}" type="${xmlEscape(entry.type)}">` +
    valueLine +
    pinLines +
    guiLine +
    "</component>";

  const ops: string[] = [];
  // Every fresh required-pin net must exist in <nets> for validation to
  // pass. Add them BEFORE the component so the component references
  // resolve on preview.
  for (const [, netId] of Object.entries(pinNets)) {
    ops.push(
      `<add path="nets"><net id="${xmlEscape(netId)}" role="signal"/></add>`,
    );
  }
  ops.push(`<add path="components">${componentXml}</add>`);
  return { patchXml: `<patch>${ops.join("")}</patch>`, newComponentId: compId };
}

// ------------------------------------------------------------------
// Delete component (issue #24 D4)
// ------------------------------------------------------------------

/**
 * Build a `<patch>` that removes `compId` outright. Any nets whose pin
 * membership drops to zero as a result are pruned in the same patch
 * (mirrors the disconnect behavior; see PARITY note at top of file).
 *
 * ASSERTION DIAGNOSTICS: the issue calls for a "confirmation if it leaves
 * an assertion probe dangling". We do NOT emit an assertion-repair op;
 * that's a caller decision (see Renderer.tsx handleDelete). Returning the
 * list of dangling probes lets the caller ask the user first.
 */
export function deleteComponentPatch(
  parsed: SystemIR,
  compId: string,
): { patchXml: string; danglingProbeTests: string[] } {
  const comp = parsed.components.get(compId);
  if (!comp) throw new Error(`unknown component ${compId}`);
  const ops: string[] = [];
  ops.push(`<remove path="components/component[@id='${compId}']"/>`);

  // Track which nets lose all their members when this component vanishes,
  // and prune them. A pin's presence on the net is the ONLY thing that
  // makes a net "connected"; other elements (interfaces, power_domains,
  // tests) that REFERENCE a net don't count as pin-membership.
  const netUsageAfter = new Map<string, number>();
  for (const c of parsed.components.values()) {
    if (c.id === compId) continue;
    for (const pin of c.pins.values()) {
      netUsageAfter.set(pin.net, (netUsageAfter.get(pin.net) ?? 0) + 1);
    }
  }
  for (const pin of comp.pins.values()) {
    const remaining = netUsageAfter.get(pin.net) ?? 0;
    if (remaining === 0 && parsed.nets.has(pin.net)) {
      // Do NOT prune ground / power / structural nets even when empty:
      // the design's <tests> and <power_domains> reference them by id
      // and would break. Signal nets are safe to prune.
      const net = parsed.nets.get(pin.net);
      if (net && net.role === "signal") {
        ops.push(`<remove path="nets/net[@id='${pin.net}']"/>`);
      }
    }
  }

  // Dangling probes: probes in analog subsystems whose `net` was ONLY
  // reachable through this component. We surface them (don't remove);
  // the caller decides whether to warn.
  const danglingProbeTests: string[] = [];
  for (const sub of parsed.analog) {
    for (const probe of sub.probes) {
      const probeNet = probe.net;
      if (!probeNet) continue;
      const stillConnected = netUsageAfter.get(probeNet) ?? 0;
      if (stillConnected === 0) {
        danglingProbeTests.push(`${sub.id}:${probe.id}`);
      }
    }
  }
  return {
    patchXml: `<patch>${ops.join("")}</patch>`,
    danglingProbeTests,
  };
}
