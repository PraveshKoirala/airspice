/**
 * Port of `packages/core/src/air/parser.py` (parse_tree).
 *
 * Consumes a normalized element tree and builds the typed SystemIR. Every
 * leniency the oracle implements is reproduced:
 *   - pin `net` falls back to `node`, then `ref` (net= / node= / ref= aliases);
 *   - net-owned `<node>` pins are materialized by the normalizer (see
 *     normalizer.ts) into component-owned `<pin>`s before we read them here;
 *   - implied roles / value-from-parameters likewise come from the normalizer.
 *
 * PARITY: the attribute names, the `.strip()` on <value>, the empty-string
 * fallbacks, the firmware `source_tree`/`board` attribute-vs-child asymmetry,
 * the test-setup special cases (set_voltage / set_current / load_step), and the
 * interface/bridge `data` shapes are copied verbatim from parser.py.
 */

import {
  type XmlElement,
  childElements,
  findAll,
  find,
  attr,
  hasAttr,
  elementText,
} from "./xml.js";
import { normalizeTree } from "./normalizer.js";
import type {
  AnalogSubsystem,
  Bridge,
  BridgeDatum,
  Component,
  ExportTarget,
  FirmwareBinding,
  FirmwareOperation,
  FirmwareProject,
  FirmwareTask,
  Interface,
  InterfaceDatum,
  Metadata,
  Net,
  PinConnection,
  PowerDomain,
  Probe,
  SimulationProfile,
  SystemIR,
  Test,
} from "./model.js";

/** Raised when the AIR document root is not <system> (mirrors ValueError). */
export class AirParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirParseError";
  }
}

/**
 * Build a SystemIR from a raw (un-normalized) element tree. Normalization is
 * applied internally on a clone; the input `root` is left untouched so the
 * caller can canonicalize the raw tree (matching parse_file's semantics, where
 * `parse_tree` rebinds `tree` locally and the caller keeps the raw tree).
 */
export function parseTree(rawRoot: XmlElement): SystemIR {
  const root = normalizeTree(rawRoot);
  if (root.tag !== "system") {
    throw new AirParseError("AIR document root must be <system>");
  }

  const metadataEl = find(root, "metadata");
  const metadata: Metadata = {
    title: childText(metadataEl, "title"),
    description: childText(metadataEl, "description"),
    author: childText(metadataEl, "author"),
    created_at: childText(metadataEl, "created_at"),
  };

  // All keyed collections are Maps: insertion (document) order for every key
  // type, mirroring Python dicts. Plain objects would iterate integer-like keys
  // (pin names "1"/"2", numeric ids) numerically first -- observable in
  // validation's emission order and pins[0] access (issue #8 rework round 1;
  // see model.ts header). Map.set matches Python dict assignment on duplicate
  // keys: last value wins, first insertion position kept.
  const nets = new Map<string, Net>();
  for (const net of findAllPath(root, "nets", "net")) {
    if (!hasAttr(net, "id")) continue;
    const id = attr(net, "id");
    nets.set(id, {
      id,
      role: attr(net, "role", ""),
      nominal_voltage: net.attrib.has("nominal_voltage")
        ? attr(net, "nominal_voltage")
        : null,
    });
  }

  const powerDomains = new Map<string, PowerDomain>();
  for (const domain of findAllPath(root, "power_domains", "domain")) {
    if (!hasAttr(domain, "id")) continue;
    const id = attr(domain, "id");
    powerDomains.set(id, {
      id,
      net: attr(domain, "net", ""),
      nominal: domain.attrib.has("nominal") ? attr(domain, "nominal") : null,
      source: domain.attrib.has("source") ? attr(domain, "source") : null,
    });
  }

  const components = new Map<string, Component>();
  for (const element of findAllPath(root, "components", "component")) {
    const componentId = attr(element, "id", "");
    const pins = new Map<string, PinConnection>();
    for (const pin of findAll(element, "pin")) {
      const name = attr(pin, "name", "");
      // net = net || node || ref || "" (Python `or`-chain on attribute values).
      const net =
        orChain(
          pin.attrib.get("net"),
          pin.attrib.get("node"),
          pin.attrib.get("ref"),
        ) ?? "";
      pins.set(name, {
        name,
        net,
        function: pin.attrib.has("function") ? attr(pin, "function") : null,
      });
    }
    const properties = new Map<string, string>();
    for (const prop of findAll(element, "property")) {
      properties.set(attr(prop, "name", ""), attr(prop, "value", ""));
    }
    const valueEl = find(element, "value");
    const valueText =
      valueEl !== null ? elementText(valueEl) : "";
    components.set(componentId, {
      id: componentId,
      type: attr(element, "type", ""),
      part: element.attrib.has("part") ? attr(element, "part") : null,
      spice_model: element.attrib.has("spice_model")
        ? attr(element, "spice_model")
        : null,
      spice_subckt: element.attrib.has("spice_subckt")
        ? attr(element, "spice_subckt")
        : null,
      // `value_el.text.strip()` only when there IS non-empty text; else None.
      value: valueEl !== null && valueText ? valueText.trim() : null,
      pins,
      properties,
    });
  }

  const analog: AnalogSubsystem[] = [];
  for (const subsystem of findAllPath(root, "analog", "subsystem")) {
    const probes: Probe[] = findAll(subsystem, "probe").map((p) => ({
      id: attr(p, "id", ""),
      net: attr(p, "net", ""),
      quantity: attr(p, "quantity", ""),
    }));
    analog.push({
      id: attr(subsystem, "id", ""),
      uses: findAll(subsystem, "uses").map((u) => attr(u, "component", "")),
      probes,
    });
  }

  const interfaces = new Map<string, Interface>();
  for (const iface of findAllPath(root, "interfaces", "interface")) {
    const data: Record<string, InterfaceDatum> = {};
    for (const child of childElements(iface)) {
      const value = attribMap(child);
      const existing = data[child.tag];
      if (existing === undefined) {
        data[child.tag] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        data[child.tag] = [existing, value];
      }
    }
    const id = attr(iface, "id", "");
    interfaces.set(id, { id, type: attr(iface, "type", ""), data });
  }

  const firmwareProjects = new Map<string, FirmwareProject>();
  const firmwareBindings = new Map<string, FirmwareBinding>();
  const firmwareTasks = new Map<string, FirmwareTask>();
  const firmwareEl = find(root, "firmware");
  if (firmwareEl !== null) {
    for (const project of findAll(firmwareEl, "project")) {
      const projectId = attr(project, "id", "");
      firmwareProjects.set(projectId, {
        id: projectId,
        target: attr(project, "target", ""),
        framework: attr(project, "framework", ""),
        language: attr(project, "language", ""),
        board: childText(project, "board"),
        // NOTE: read as an ATTRIBUTE. When source_tree is a child element
        // (<source_tree path="..."/>) there is no attribute, so this is "".
        source_tree: attr(project, "source_tree", ""),
      });
    }
    for (const binding of findAll(firmwareEl, "binding")) {
      const bindingId = attr(binding, "id", "");
      firmwareBindings.set(bindingId, {
        id: bindingId,
        signal: childAttr(binding, "signal", "name"),
        component: childAttr(binding, "component", "ref"),
        peripheral: childText(binding, "peripheral"),
        channel: childText(binding, "channel"),
        net: childText(binding, "net"),
      });
    }
    for (const task of findAll(firmwareEl, "task")) {
      const taskId = attr(task, "id", "");
      const operations: FirmwareOperation[] = [];
      for (const child of childElements(task)) {
        if (child.tag === "period") continue;
        const op: FirmwareOperation = { op: child.tag };
        for (const [k, v] of child.attrib) op[k] = v;
        const text = elementText(child).trim();
        if (text) op["text"] = text;
        operations.push(op);
      }
      firmwareTasks.set(taskId, {
        id: taskId,
        target: attr(task, "target", ""),
        period: childText(task, "period"),
        operations,
      });
    }
  }

  const bridges: Bridge[] = [];
  for (const b of findAllPath(root, "bridges", "bridge")) {
    const bridgeData: Record<string, BridgeDatum> = {};
    // Start with the bridge's own attributes (flat strings)...
    for (const [k, v] of b.attrib) bridgeData[k] = v;
    // ...then overlay each child tag with its attribute map.
    for (const child of childElements(b)) {
      bridgeData[child.tag] = attribMap(child);
    }
    bridges.push({
      id: attr(b, "id", ""),
      type: attr(b, "type", ""),
      data: bridgeData,
    });
  }

  const tests = new Map<string, Test>();
  for (const test of findAllPath(root, "tests", "test")) {
    const testId = attr(test, "id", "");
    const setup = new Map<string, string>();
    // PARITY (rework round 1 audit): the oracle iterates test.findall("./setup/*")
    // -- the children of EVERY <setup> section under the test, not just the
    // first. Same multi-section family as the DUPLICATE_ID scan (root cause B).
    const setupChildren: XmlElement[] = [];
    for (const setupEl of findAll(test, "setup")) {
      for (const child of childElements(setupEl)) setupChildren.push(child);
    }
    for (const child of setupChildren) {
      if (child.tag === "set_voltage") {
        setup.set(attr(child, "net", child.tag), attr(child, "value", ""));
      } else if (child.tag === "set_current") {
        setup.set(`current:${attr(child, "component", "")}`, attr(
          child,
          "value",
          "",
        ));
      } else if (child.tag === "load_step") {
        const component = attr(child, "component", "");
        setup.set(`load_step:${component}`, [
          attr(child, "from", ""),
          attr(child, "to", ""),
          attr(child, "at", "0s"),
          attr(child, "rise", "1us"),
        ].join(","));
      } else {
        setup.set(attr(child, "net", child.tag), attr(child, "value", ""));
      }
    }
    const assertions: Array<Record<string, string>> = [];
    for (const assertion of childElements(test)) {
      if (assertion.tag.startsWith("assert_")) {
        const a: Record<string, string> = {};
        for (const [k, v] of assertion.attrib) a[k] = v;
        a["op"] = assertion.tag;
        assertions.push(a);
      }
    }
    const run = find(test, "run");
    tests.set(testId, {
      id: testId,
      description: childText(test, "description"),
      setup,
      duration: run !== null ? attr(run, "duration", "") : "",
      assertions,
    });
  }

  const profiles = new Map<string, SimulationProfile>();
  for (const profile of findAllPath(root, "simulation_profiles", "profile")) {
    const profileId = attr(profile, "id", "");
    const props = new Map<string, string>();
    for (const p of findAll(profile, "property")) {
      const name = p.attrib.get("name");
      if (name) {
        props.set(name, attr(p, "value", ""));
      }
    }
    profiles.set(profileId, {
      id: profileId,
      default: attr(profile, "default", "false").toLowerCase() === "true",
      backends: findAll(profile, "backend").map((b) => attr(b, "type", "")),
      included_subsystems: findAll(profile, "include").map((i) =>
        attr(i, "subsystem", ""),
      ),
      tests: findAll(profile, "run").map((r) => attr(r, "test", "")),
      properties: props,
    });
  }

  const exports: ExportTarget[] = findAllPath(root, "exports", "export").map(
    (e) => ({
      target: attr(e, "target", ""),
      enabled: attr(e, "enabled", "false").toLowerCase() === "true",
    }),
  );

  return {
    name: attr(root, "name", ""),
    ir_version: attr(root, "ir_version", ""),
    metadata,
    requirements: [],
    nets,
    power_domains: powerDomains,
    components,
    interfaces,
    analog,
    firmware_projects: firmwareProjects,
    firmware_bindings: firmwareBindings,
    firmware_tasks: firmwareTasks,
    bridges,
    tests,
    simulation_profiles: profiles,
    exports,
  };
}

// --- helpers ---------------------------------------------------------------- #

function findAllPath(root: XmlElement, a: string, b: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const container of findAll(root, a)) {
    for (const el of findAll(container, b)) out.push(el);
  }
  return out;
}

/** Mirror of parser._text: stripped text of child `tag`, or "" (parent null). */
function childText(parent: XmlElement | null, tag: string): string {
  if (parent === null) return "";
  const child = find(parent, tag);
  if (child === null) return "";
  const text = elementText(child);
  return text ? text.trim() : "";
}

/** Mirror of parser._child_attr: attr `attrName` of child `tag`, or "". */
function childAttr(parent: XmlElement, tag: string, attrName: string): string {
  const child = find(parent, tag);
  return child !== null ? attr(child, attrName, "") : "";
}

/** dict(child.attrib): plain object of an element's attributes, ordered. */
function attribMap(el: XmlElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of el.attrib) out[k] = v;
  return out;
}

/**
 * Python `a or b or c` on attribute values: the first truthy (non-empty,
 * present) string wins; falls through to undefined so the caller can `?? ""`.
 * An empty-string attribute is falsy in Python, so it is skipped.
 */
function orChain(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v) return v;
  }
  return undefined;
}
