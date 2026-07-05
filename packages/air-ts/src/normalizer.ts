/**
 * Port of `packages/core/src/air/normalizer.py`.
 *
 * Absorbs the common ways an LLM deviates from the AIR shape BEFORE the model
 * parser reads the tree. Operates on a deep clone of the root (like the oracle's
 * `deepcopy(tree.getroot())`) so the caller's tree is untouched -- this matters
 * because the oracle canonicalizes the RAW (un-normalized) tree while the model
 * is built from the normalized one (see parser.ts / index.ts).
 *
 * PARITY: every coercion, the `_infer_net_role` table, the value-from-parameters
 * candidate lists, the `_with_default_unit` rules, and the bjt spice_model
 * inference are copied verbatim from normalizer.py. Do not add or "improve"
 * coercions here.
 */

import {
  type XmlElement,
  childElements,
  findAll,
  find,
  attr,
  hasAttr,
} from "./xml.js";

/**
 * Known component types = COMPONENT_SPECS keys ∪ {"mcu","sensor","battery"}.
 * COMPONENT_SPECS is the built-in set (registry/components/*.json only re-declare
 * these same types), so the set is fixed. Mirrors registry._known_component_types.
 */
const KNOWN_COMPONENT_TYPES = new Set<string>([
  "resistor",
  "capacitor",
  "voltage_source",
  "current_source",
  "generic_load",
  "ldo",
  "mosfet",
  "diode",
  "bjt",
  "mcu",
  "sensor",
  "battery",
]);

/** Deep-clone an element tree (mirrors ElementTree deepcopy). */
export function cloneElement(el: XmlElement): XmlElement {
  return {
    kind: "element",
    tag: el.tag,
    attrib: new Map(el.attrib),
    children: el.children.map((c) =>
      c.kind === "element" ? cloneElement(c) : { kind: "text", value: c.value },
    ),
  };
}

/**
 * Normalize a cloned root. Returns the same (mutated) clone. If the root tag is
 * not "system", it is returned unchanged (matching normalize_air_tree).
 */
export function normalizeTree(root: XmlElement): XmlElement {
  const clone = cloneElement(root);
  if (clone.tag !== "system") {
    return clone;
  }
  coerceStructure(clone);
  normalizeNets(clone);
  normalizeComponents(clone);
  normalizeSimulationProfiles(clone);
  return clone;
}

// --- helpers to navigate section/child paths -------------------------------- #

/** findall("./a/b"): elements `b` inside the first-level container(s) `a`. */
function findAllPath(root: XmlElement, a: string, b: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const container of findAll(root, a)) {
    for (const el of findAll(container, b)) out.push(el);
  }
  return out;
}

// --- _coerce_structure ------------------------------------------------------ #

function coerceStructure(root: XmlElement): void {
  const paths: Array<[string, string]> = [
    ["nets", "net"],
    ["components", "component"],
    ["tests", "test"],
    ["simulation_profiles", "profile"],
  ];
  for (const [a, b] of paths) {
    for (const element of findAllPath(root, a, b)) {
      if (!hasAttr(element, "id") && hasAttr(element, "name")) {
        element.attrib.set("id", attr(element, "name"));
      }
    }
  }
  for (const component of findAllPath(root, "components", "component")) {
    const wrapper = find(component, "pins");
    if (wrapper !== null) {
      // Append the wrapper's <pin> children directly onto the component, then
      // remove the wrapper (ElementTree append/remove preserve order).
      for (const pin of findAll(wrapper, "pin")) {
        component.children.push(pin);
      }
      component.children = component.children.filter((c) => c !== wrapper);
    }
  }
}

// --- _normalize_nets -------------------------------------------------------- #

function normalizeNets(root: XmlElement): void {
  const components = new Map<string, XmlElement>();
  for (const component of findAllPath(root, "components", "component")) {
    components.set(attr(component, "id"), component);
  }
  for (const net of findAllPath(root, "nets", "net")) {
    const netId = attr(net, "id");
    if (!netId) continue;
    if (!net.attrib.has("role")) {
      net.attrib.set("role", inferNetRole(netId));
    }
    for (const node of findAll(net, "node")) {
      const component = components.get(attr(node, "component"));
      const pinName = attr(node, "pin");
      if (component === undefined || !pinName) continue;
      const normalizedPin = normalizePinName(attr(component, "type"), pinName);
      const exists = findAll(component, "pin").some(
        (pin) => attr(pin, "name") === normalizedPin,
      );
      if (!exists) {
        subElement(component, "pin", { name: normalizedPin, net: netId });
      }
    }
  }
}

// --- _normalize_components -------------------------------------------------- #

function normalizeComponents(root: XmlElement): void {
  for (const component of findAllPath(root, "components", "component")) {
    let componentType = attr(component, "type");
    if (!componentType) {
      const part = attr(component, "part");
      if (part && KNOWN_COMPONENT_TYPES.has(part.toLowerCase())) {
        componentType = part.toLowerCase();
        component.attrib.set("type", componentType);
        component.attrib.delete("part");
      }
    }

    for (const pin of findAll(component, "pin")) {
      if (pin.attrib.has("name")) {
        pin.attrib.set(
          "name",
          normalizePinName(componentType, attr(pin, "name")),
        );
      }
      if (!pin.attrib.has("net")) {
        const net = pin.attrib.get("node") ?? pin.attrib.get("ref");
        if (net) {
          pin.attrib.set("net", net);
        }
      }
    }

    if (find(component, "value") === null) {
      const value = valueFromParameters(component);
      if (value) {
        const valueEl: XmlElement = {
          kind: "element",
          tag: "value",
          attrib: new Map(),
          children: [{ kind: "text", value }],
        };
        // Insert before the first <pin>, at the same positional index ET uses.
        const firstPin = find(component, "pin");
        const insertAt =
          firstPin !== null ? component.children.indexOf(firstPin) : 0;
        component.children.splice(insertAt, 0, valueEl);
      }
    }

    if (componentType === "bjt") {
      const transistorType = parameterValue(component, "type");
      if (transistorType && !component.attrib.has("spice_model")) {
        component.attrib.set(
          "spice_model",
          transistorType.toLowerCase() === "pnp" ? "PNP" : "NPN",
        );
      }
    }
  }
}

// --- _normalize_simulation_profiles ----------------------------------------- #

function normalizeSimulationProfiles(root: XmlElement): void {
  const profilesEl = find(root, "simulation_profiles");
  if (profilesEl === null) return;
  const testIds = findAllPath(root, "tests", "test")
    .map((t) => attr(t, "id"))
    .filter((id) => id !== "");
  const analogIds = findAllPath(root, "analog", "subsystem")
    .map((s) => attr(s, "id"))
    .filter((id) => id !== "");
  for (const child of childElements(profilesEl)) {
    if (child.tag === "simulation_profile") {
      child.tag = "profile";
    }
    if (child.tag !== "profile") continue;
    const solver = child.attrib.get("solver") ?? "";
    child.attrib.delete("solver");
    if (solver && find(child, "backend") === null) {
      subElement(child, "backend", { type: solver });
    }
    if (find(child, "backend") === null) {
      subElement(child, "backend", { type: "ngspice" });
    }
    if (findAll(child, "run").length === 0) {
      for (const testId of testIds) {
        subElement(child, "run", { test: testId });
      }
    }
    if (findAll(child, "include").length === 0) {
      for (const analogId of analogIds) {
        subElement(child, "include", { subsystem: analogId });
      }
    }
  }
}

// --- value/parameter helpers ------------------------------------------------ #

function valueFromParameters(component: XmlElement): string {
  const componentType = attr(component, "type");
  const table: Record<string, string[]> = {
    resistor: ["resistance", "value"],
    capacitor: ["capacitance", "value"],
    voltage_source: ["voltage", "value"],
    current_source: ["current", "value"],
    generic_load: ["current", "resistance", "value"],
  };
  const candidates = table[componentType] ?? ["value"];
  for (const name of candidates) {
    const value = parameterValue(component, name);
    if (value) {
      return withDefaultUnit(value, componentType, name);
    }
  }
  return "";
}

function parameterValue(component: XmlElement, name: string): string {
  for (const parameter of findAll(component, "parameter")) {
    if (attr(parameter, "name").toLowerCase() === name.toLowerCase()) {
      return attr(parameter, "value");
    }
  }
  return "";
}

function withDefaultUnit(
  value: string,
  componentType: string,
  parameterName: string,
): string {
  const stripped = value.trim();
  if (/[a-zA-Z]/.test(stripped)) {
    return stripped;
  }
  if (componentType === "voltage_source") return `${stripped}V`;
  if (componentType === "current_source" || parameterName === "current") {
    return `${stripped}A`;
  }
  if (componentType === "capacitor") return `${stripped}F`;
  return stripped;
}

function normalizePinName(componentType: string, pinName: string): string {
  if (componentType === "bjt" || componentType === "mosfet") {
    return pinName.toUpperCase();
  }
  return pinName;
}

function inferNetRole(netId: string): string {
  const normalized = netId.toLowerCase();
  if (["gnd", "ground", "0", "vss"].includes(normalized)) return "ground";
  if (
    [
      "vcc",
      "vdd",
      "vin",
      "bat",
      "battery",
      "3v3",
      "5v",
      "+3v3",
      "+5v",
    ].includes(normalized)
  ) {
    return "power";
  }
  return "analog_signal";
}

/** Create and append a child element (mirrors ET.SubElement). */
function subElement(
  parent: XmlElement,
  tag: string,
  attribs: Record<string, string>,
): XmlElement {
  const el: XmlElement = {
    kind: "element",
    tag,
    attrib: new Map(Object.entries(attribs)),
    children: [],
  };
  parent.children.push(el);
  return el;
}
