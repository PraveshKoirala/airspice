/**
 * Port of `packages/core/src/air/validation.py` -- the schema + electrical rule
 * checks that make agent output trustworthy (north-star principle 3, issue #8).
 *
 * Every rule is a direct, line-by-line mirror of the oracle: same diagnostic
 * code, severity, domain, message text, related_elements, observed/expected
 * payloads, and -- critically -- the same EMISSION ORDER. Python emits in
 * document order (iterating dicts/lists in insertion order). The model stores
 * every dict-mirroring collection as a Map, whose iteration order is insertion
 * order for ALL key types. Plain JS objects would NOT preserve it: integer-like
 * keys ("1", "2", "10" -- the norm for passive pin names, legal for any id)
 * iterate in ascending numeric order first, which diverged from the oracle in
 * emission order, in `list(pins)[0]` positional access (load budget), and in
 * float accumulation order (issue #8 rework round 1, root cause A). See
 * model.ts; iterating the Maps reproduces the oracle exactly.
 *
 * PARITY notes are inline where the oracle does something surprising that must
 * be replicated rather than "corrected" (AGENTS.md rule 11 / issue guardrail).
 */

import type {
  Component,
  FirmwareBinding,
  Interface,
  Net,
  SystemIR,
} from "../model.js";
import { parseQuantity } from "../units.js";
import {
  COMPONENT_SPECS,
  MCUS,
  PASSIVE_TYPES,
  SUPPORTED_SPICE_TYPES,
  BUILTIN_SPICE_MODELS,
  BUILTIN_SPICE_SUBCKTS,
  type McuSpec,
} from "../registry/index.js";
import { type Diagnostic, DiagnosticBuilder } from "./diagnostics.js";
import { asList, formatG } from "./helpers.js";

/**
 * Component types whose device line carries a SPICE `.model` reference (see
 * validation._MODELLED_SPICE_TYPES). Only these trigger the UNDEFINED_SPICE_MODEL
 * model-name check (the subckt check applies to any type).
 */
const MODELLED_SPICE_TYPES: ReadonlySet<string> = new Set(["bjt", "mosfet", "diode"]);

/** Python `sorted(iterable)` over strings: code-point order. */
function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Format a Python f-string `{x:.3g}` numeric fragment (no unit). */
function g3(x: number): string {
  return formatG(x, 3);
}

/** Format a Python f-string `{x:.6g}` numeric fragment (no unit). */
function g6(x: number): string {
  return formatG(x, 6);
}

// --------------------------------------------------------------------------- //
// validate_tree: schema-level checks over the raw element tree.               //
// --------------------------------------------------------------------------- //

/**
 * Port of validation.validate_tree. Operates on the RAW element structure, so
 * this port takes the same shape the oracle inspects: the root tag, its
 * attributes, the presence of each top-level <section>, and duplicate ids per
 * collection. We express it over the already-parsed `SystemIR` PLUS a light
 * schema view derived from the tree, because air-ts's parser has consumed the
 * ElementTree. See validateTreeFromModel below for the model-derived form used
 * by the corpus (every committed design has a well-formed <system> root with all
 * sections and unique ids, so validate_tree emits nothing for them).
 */
export interface TreeSchemaView {
  rootTag: string;
  rootAttribs: Record<string, string>;
  presentSections: ReadonlySet<string>;
  /**
   * id -> count, per collection kind, for the DUPLICATE_ID check. Maps, not
   * Records: the oracle's `ids: dict[str, int]` iterates in FIRST-SEEN order,
   * which a plain object breaks for integer-like ids (rework round 1, probe A3:
   * duplicate net ids "10","2" must report "10" first).
   */
  idCounts: {
    net: Map<string, number>;
    component: Map<string, number>;
    test: Map<string, number>;
    profile: Map<string, number>;
  };
}

const SECTION_ORDER = ["metadata", "nets", "components", "tests", "simulation_profiles"] as const;
// The DUPLICATE_ID query order in validation.validate_tree (dict literal order).
const DUP_ID_ORDER: Array<keyof TreeSchemaView["idCounts"]> = [
  "net",
  "component",
  "test",
  "profile",
];

export function validateTree(view: TreeSchemaView): Diagnostic[] {
  const builder = new DiagnosticBuilder();
  const diagnostics: Diagnostic[] = [];
  if (view.rootTag !== "system") {
    diagnostics.push(builder.make("error", "schema", "INVALID_ROOT", "Root element must be <system>."));
    return diagnostics;
  }
  for (const attr of ["name", "ir_version"]) {
    if (!view.rootAttribs[attr]) {
      diagnostics.push(
        builder.make("error", "schema", "MISSING_SYSTEM_ATTR", `System is missing required '${attr}' attribute.`),
      );
    }
  }
  for (const section of SECTION_ORDER) {
    if (!view.presentSections.has(section)) {
      diagnostics.push(builder.make("error", "schema", "MISSING_SECTION", `Missing <${section}> section.`));
    }
  }
  for (const tag of DUP_ID_ORDER) {
    const counts = view.idCounts[tag];
    for (const [elementId, count] of counts) {
      if (count > 1) {
        diagnostics.push(
          builder.make("error", "schema", "DUPLICATE_ID", `Duplicate ${tag} id '${elementId}'.`, {
            relatedElements: [elementId],
          }),
        );
      }
    }
  }
  return diagnostics;
}

// --------------------------------------------------------------------------- //
// validate_ir: semantic + electrical rule checks over the typed model.        //
// --------------------------------------------------------------------------- //

export function validateIr(ir: SystemIR): Diagnostic[] {
  const builder = new DiagnosticBuilder();
  const diagnostics: Diagnostic[] = [];

  if (ir.nets.size === 0) {
    diagnostics.push(builder.make("error", "semantic", "NO_NETS", "Design must define at least one net."));
  }
  const groundNets = [...ir.nets.values()]
    .filter((net) => net.role === "ground")
    .map((net) => net.id);
  if (groundNets.length === 0) {
    diagnostics.push(builder.make("error", "electrical", "MISSING_GROUND", "Design must define a ground net."));
  }

  // component_ids = [cid for cid in ir.components if cid] -- keys, filtering falsy.
  const componentIds = [...ir.components.keys()].filter((cid) => cid);
  if (componentIds.length !== new Set(componentIds).size) {
    diagnostics.push(
      builder.make("error", "semantic", "DUPLICATE_COMPONENT_ID", "Component IDs must be unique."),
    );
  }

  for (const component of ir.components.values()) {
    if (!component.id) {
      diagnostics.push(builder.make("error", "semantic", "MISSING_COMPONENT_ID", "A component is missing an id."));
    }
    if (!component.type) {
      diagnostics.push(
        builder.make("error", "semantic", "MISSING_COMPONENT_TYPE", `Component ${component.id} is missing a type.`, {
          relatedElements: [component.id],
        }),
      );
    }
    for (const d of validateComponentRegistryRules(component, builder)) diagnostics.push(d);
    for (const d of validateSpiceModels(component, builder)) diagnostics.push(d);
    for (const pin of component.pins.values()) {
      if (!ir.nets.has(pin.net)) {
        diagnostics.push(
          builder.make(
            "error",
            "semantic",
            "UNKNOWN_NET",
            `Component ${component.id}.${pin.name} references undefined net '${pin.net}'.`,
            { relatedElements: [component.id, pin.net] },
          ),
        );
      }
    }
    if (!PASSIVE_TYPES.has(component.type)) {
      const pinNets = new Set([...component.pins.values()].map((pin) => pin.net));
      const hasGround = [...pinNets].some((netId) => {
        const net = ir.nets.get(netId);
        return net !== undefined && net.role === "ground";
      });
      const hasPower = [...pinNets].some((netId) => {
        const net = ir.nets.get(netId);
        return net !== undefined && net.role === "power";
      });
      if ((component.type === "mcu" || component.type === "ldo") && (!hasGround || !hasPower)) {
        diagnostics.push(
          builder.make(
            "error",
            "power",
            "MISSING_POWER_OR_GROUND",
            `Non-passive component ${component.id} must connect to power and ground.`,
            { relatedElements: [component.id] },
          ),
        );
      }
    }
    if (component.type === "mcu") {
      for (const d of validateMcu(component, builder)) diagnostics.push(d);
    }
    if (!SUPPORTED_SPICE_TYPES.has(component.type) && component.type !== "mcu") {
      diagnostics.push(
        builder.make(
          "warning",
          "compiler",
          "UNSUPPORTED_SPICE_TYPE",
          `Component ${component.id} type ${component.type} is not supported by the v0.1 SPICE compiler.`,
          { relatedElements: [component.id] },
        ),
      );
    }
    if (component.type === "generic_load") {
      for (const d of validateGenericLoad(component, builder)) diagnostics.push(d);
    }
  }

  for (const domain of ir.power_domains.values()) {
    if (!ir.nets.has(domain.net)) {
      diagnostics.push(
        builder.make(
          "error",
          "power",
          "POWER_DOMAIN_UNKNOWN_NET",
          `Power domain ${domain.id} references undefined net '${domain.net}'.`,
          { relatedElements: [domain.id, domain.net] },
        ),
      );
    }
  }
  for (const d of validateLoadBudget(ir, builder)) diagnostics.push(d);

  for (const subsystem of ir.analog) {
    for (const componentId of subsystem.uses) {
      if (!ir.components.has(componentId)) {
        diagnostics.push(
          builder.make(
            "error",
            "analog",
            "UNKNOWN_ANALOG_COMPONENT",
            `Analog subsystem ${subsystem.id} references unknown component ${componentId}.`,
            { relatedElements: [subsystem.id, componentId] },
          ),
        );
      }
    }
    for (const probe of subsystem.probes) {
      if (!ir.nets.has(probe.net)) {
        diagnostics.push(
          builder.make("error", "analog", "UNKNOWN_PROBE_NET", `Probe ${probe.id} references undefined net '${probe.net}'.`, {
            relatedElements: [probe.id, probe.net],
          }),
        );
      }
    }
  }

  for (const iface of ir.interfaces.values()) {
    if (iface.type === "i2c") {
      for (const d of validateI2c(ir, iface, builder)) diagnostics.push(d);
    }
  }

  for (const project of ir.firmware_projects.values()) {
    if (!ir.components.has(project.target)) {
      diagnostics.push(
        builder.make(
          "error",
          "firmware",
          "UNKNOWN_FIRMWARE_TARGET",
          `Firmware project ${project.id} targets unknown component ${project.target}.`,
          { relatedElements: [project.id, project.target] },
        ),
      );
    }
  }
  for (const binding of ir.firmware_bindings.values()) {
    if (!ir.components.has(binding.component)) {
      diagnostics.push(
        builder.make(
          "error",
          "firmware",
          "UNKNOWN_BINDING_COMPONENT",
          `Firmware binding ${binding.id} references unknown component ${binding.component}.`,
          { relatedElements: [binding.id, binding.component] },
        ),
      );
    }
    if (!ir.nets.has(binding.net)) {
      diagnostics.push(
        builder.make(
          "error",
          "firmware",
          "UNKNOWN_BINDING_NET",
          `Firmware binding ${binding.id} references unknown net ${binding.net}.`,
          { relatedElements: [binding.id, binding.net] },
        ),
      );
    }
    for (const d of validateAdcBinding(ir, binding, builder)) diagnostics.push(d);
  }
  for (const task of ir.firmware_tasks.values()) {
    if (!ir.firmware_projects.has(task.target)) {
      diagnostics.push(
        builder.make(
          "error",
          "firmware",
          "UNKNOWN_TASK_TARGET",
          `Firmware task ${task.id} targets unknown project ${task.target}.`,
          { relatedElements: [task.id, task.target] },
        ),
      );
    }
  }

  for (const test of ir.tests.values()) {
    for (const netId of test.setup.keys()) {
      if (netId.startsWith("current:") || netId.startsWith("load_step:")) {
        const componentId = netId.split(":").slice(1).join(":");
        if (!ir.components.has(componentId)) {
          diagnostics.push(
            builder.make(
              "error",
              "test",
              "TEST_SETUP_UNKNOWN_COMPONENT",
              `Test ${test.id} references unknown component ${componentId}.`,
              { relatedElements: [test.id, componentId] },
            ),
          );
        }
      } else if (!ir.nets.has(netId)) {
        diagnostics.push(
          builder.make("error", "test", "TEST_SETUP_UNKNOWN_NET", `Test ${test.id} sets undefined net ${netId}.`, {
            relatedElements: [test.id, netId],
          }),
        );
      }
    }
    for (const assertion of test.assertions) {
      const netId = assertion["net"];
      if (netId && !ir.nets.has(netId)) {
        diagnostics.push(
          builder.make("error", "test", "ASSERT_UNKNOWN_NET", `Test ${test.id} asserts undefined net ${netId}.`, {
            relatedElements: [test.id, netId],
          }),
        );
      }
      const componentId = assertion["component"];
      if (componentId && !ir.components.has(componentId)) {
        diagnostics.push(
          builder.make(
            "error",
            "test",
            "ASSERT_UNKNOWN_COMPONENT",
            `Test ${test.id} asserts unknown component ${componentId}.`,
            { relatedElements: [test.id, componentId] },
          ),
        );
      }
    }
  }

  for (const profile of ir.simulation_profiles.values()) {
    for (const backend of profile.backends) {
      if (backend !== "ngspice" && backend !== "renode") {
        diagnostics.push(
          builder.make(
            "error",
            "simulation",
            "UNSUPPORTED_BACKEND",
            `Profile ${profile.id} uses unsupported backend ${backend}.`,
            { relatedElements: [profile.id] },
          ),
        );
      }
    }
    for (const testId of profile.tests) {
      if (!ir.tests.has(testId)) {
        diagnostics.push(
          builder.make(
            "error",
            "simulation",
            "PROFILE_UNKNOWN_TEST",
            `Profile ${profile.id} references unknown test ${testId}.`,
            { relatedElements: [profile.id, testId] },
          ),
        );
      }
    }
    const subsystemIds = new Set(ir.analog.map((subsystem) => subsystem.id));
    for (const subsystemId of profile.included_subsystems) {
      if (!subsystemIds.has(subsystemId)) {
        diagnostics.push(
          builder.make(
            "error",
            "simulation",
            "PROFILE_UNKNOWN_SUBSYSTEM",
            `Profile ${profile.id} references unknown subsystem ${subsystemId}.`,
            { relatedElements: [profile.id, subsystemId] },
          ),
        );
      }
    }
  }

  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_i2c                                                               //
// --------------------------------------------------------------------------- //

function validateI2c(ir: SystemIR, iface: Interface, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const data = iface.data;

  // Helper mirroring get_val: data[key] if present, else a matching property.
  const getVal = (key: string, fallback: string): string => {
    if (key in data) {
      const direct = data[key];
      if (typeof direct === "string") return direct;
      // Python returns data[key] as-is; only string keys ever reach parse below.
      return String(direct as unknown);
    }
    const properties = asList(data["property"]);
    for (const p of properties) {
      if (p["name"] === key) return p["value"] ?? fallback;
    }
    return fallback;
  };

  for (const key of ["sda", "scl"] as const) {
    const entry = data[key];
    // isinstance(entry, dict) and entry.get("net") not in ir.nets
    if (isDict(entry)) {
      const net = entry["net"];
      if (!(typeof net === "string" && ir.nets.has(net))) {
        diagnostics.push(
          builder.make(
            "error",
            "interface",
            "I2C_UNKNOWN_NET",
            `I2C interface ${iface.id} ${key} references an undefined net.`,
            { relatedElements: [iface.id] },
          ),
        );
      }
    }
  }

  const pullups = asList(data["pullup"]);
  if (pullups.length < 2) {
    diagnostics.push(
      builder.make(
        "error",
        "interface",
        "I2C_PULLUPS_NOT_DECLARED",
        `I2C interface ${iface.id} must declare SDA and SCL pullups.`,
        { relatedElements: [iface.id] },
      ),
    );
  }

  for (const pullup of pullups) {
    const pullupNet = pullup["net"] ?? "";
    const rail = pullup["to"] ?? "";
    if (!ir.nets.has(pullupNet)) {
      diagnostics.push(
        builder.make(
          "error",
          "interface",
          "I2C_PULLUP_UNKNOWN_NET",
          `I2C interface ${iface.id} pullup references undefined net ${pullupNet}.`,
          { relatedElements: [iface.id, pullupNet] },
        ),
      );
    }
    if (!ir.nets.has(rail)) {
      diagnostics.push(
        builder.make(
          "error",
          "interface",
          "I2C_PULLUP_UNKNOWN_RAIL",
          `I2C interface ${iface.id} pullup references undefined rail ${rail}.`,
          { relatedElements: [iface.id, rail] },
        ),
      );
    } else if ((ir.nets.get(rail) as Net).role !== "power") {
      diagnostics.push(
        builder.make(
          "error",
          "interface",
          "I2C_PULLUP_NOT_POWER_RAIL",
          `I2C interface ${iface.id} pullup rail ${rail} is not a power net.`,
          { relatedElements: [iface.id, rail] },
        ),
      );
    }
  }

  // controller_info = data.get("controller", {})
  const controllerInfo = isDict(data["controller"]) ? data["controller"] : {};
  const mcuId = String(controllerInfo["component"] ?? "");
  const mcu = ir.components.get(mcuId);
  if (mcu && mcu.type === "mcu") {
    const mcuRailPin = mcu.pins.get("3V3"); // Heuristic: check 3V3 rail
    if (mcuRailPin) {
      for (const pullup of pullups) {
        const rail = pullup["to"];
        if (rail && rail !== mcuRailPin.net) {
          diagnostics.push(
            builder.make(
              "error",
              "interface",
              "I2C_VOLTAGE_MISMATCH",
              `I2C pullup rail ${rail} differs from MCU rail ${mcuRailPin.net}.`,
              { relatedElements: [iface.id, rail, mcu.id] },
            ),
          );
        }
      }
    }
  }

  const speed = getVal("speed", "100kHz");
  let speedHz: number;
  try {
    speedHz = parseQuantity(String(speed), "Hz");
  } catch {
    speedHz = 100000;
  }

  for (const pullup of pullups) {
    const valStr = pullup["value"];
    if (!valStr) continue;
    try {
      const val = parseQuantity(valStr, "ohm");
      if (speedHz > 100000 && val > 2200) {
        diagnostics.push(
          builder.make("warning", "interface", "I2C_PULLUP_TOO_WEAK", `I2C pullup ${valStr} may be too weak for ${speed}.`, {
            relatedElements: [iface.id],
          }),
        );
      } else if (val > 10000) {
        diagnostics.push(
          builder.make("warning", "interface", "I2C_PULLUP_TOO_WEAK", `I2C pullup ${valStr} is very weak (>10k).`, {
            relatedElements: [iface.id],
          }),
        );
      } else if (val < 1000) {
        diagnostics.push(
          builder.make("warning", "interface", "I2C_PULLUP_TOO_STRONG", `I2C pullup ${valStr} is very strong (<1k).`, {
            relatedElements: [iface.id],
          }),
        );
      }
    } catch {
      // parse_quantity failed -> pass (oracle: except ValueError: pass)
    }
  }

  return diagnostics;
}

/** True for a non-null, non-array object value in an interface data bag. */
function isDict(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --------------------------------------------------------------------------- //
// _validate_mcu                                                               //
// --------------------------------------------------------------------------- //

function validateMcu(component: Component, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!component.part || !(component.part in MCUS)) {
    diagnostics.push(
      builder.make("error", "pin", "UNKNOWN_MCU_PART", `MCU component ${component.id} uses unsupported part ${component.part}.`, {
        relatedElements: [component.id],
      }),
    );
    return diagnostics;
  }
  const registry = MCUS[component.part] as McuSpec;
  // Registry power_pins stays a plain object: its keys are rail names ("3V3",
  // "GND", "VDD"...), never pure integers, so object iteration == JSON file
  // order == Python dict order. gen-registry.mjs enforces the "never pure
  // integers" invariant at generation time (it errors on an integer-like key),
  // so this iteration cannot silently reorder like component/pin Maps could.
  for (const requiredPin of Object.keys(registry.power_pins)) {
    if (!component.pins.has(requiredPin)) {
      diagnostics.push(
        builder.make("error", "pin", "MISSING_MCU_POWER_PIN", `MCU ${component.id} is missing required pin ${requiredPin}.`, {
          relatedElements: [component.id],
        }),
      );
    }
  }
  for (const pin of component.pins.values()) {
    if (pin.name in registry.power_pins) continue;
    const supported = registry.pins[pin.name];
    if (supported === undefined) {
      diagnostics.push(
        builder.make("warning", "pin", "UNKNOWN_MCU_PIN", `MCU ${component.id} pin ${pin.name} is not in the registry.`, {
          relatedElements: [component.id],
        }),
      );
      continue;
    }
    if (pin.function && !supported.includes(pin.function)) {
      diagnostics.push(
        builder.make(
          "error",
          "pin",
          "UNSUPPORTED_PIN_FUNCTION",
          `MCU ${component.id} pin ${pin.name} does not support function ${pin.function}.`,
          {
            relatedElements: [component.id, pin.name],
            observed: { function: pin.function },
            expected: { supported: sortedStrings(supported) },
          },
        ),
      );
    }
  }
  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_spice_models (issue #55)                                          //
// --------------------------------------------------------------------------- //

function validateSpiceModels(component: Component, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const subckt = component.spice_subckt;
  if (subckt && !BUILTIN_SPICE_SUBCKTS.has(subckt.trim().toUpperCase())) {
    diagnostics.push(
      builder.make(
        "error",
        "compiler",
        "UNDEFINED_SPICE_MODEL",
        `Component ${component.id} references SPICE subcircuit '${subckt}' with no ` +
          `model source; the compiler emits no .subckt definition for it and ngspice ` +
          `cannot simulate the design.`,
        {
          relatedElements: [component.id, subckt],
          observed: { spice_subckt: subckt },
          suggestedActions: [
            "Import a SPICE subcircuit that defines this part, or",
            "Model the part with supported primitives",
          ],
        },
      ),
    );
  }
  const model = component.spice_model;
  if (model && MODELLED_SPICE_TYPES.has(component.type) && !BUILTIN_SPICE_MODELS.has(model.trim().toUpperCase())) {
    const sortedModels = sortedStrings(BUILTIN_SPICE_MODELS);
    const joined = sortedModels.join(", ");
    diagnostics.push(
      builder.make(
        "error",
        "compiler",
        "UNDEFINED_SPICE_MODEL",
        `Component ${component.id} references SPICE model '${model}' with no model ` +
          `source; the compiler emits no .model card for it (only the generic ` +
          `${joined}) and ngspice cannot simulate the design.`,
        {
          relatedElements: [component.id, model],
          observed: { spice_model: model },
          expected: { builtin_models: sortedModels },
          suggestedActions: [
            "Import a SPICE .model that defines this part, or",
            `Use a generic model (${joined})`,
          ],
        },
      ),
    );
  }
  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_component_registry_rules                                          //
// --------------------------------------------------------------------------- //

function validateComponentRegistryRules(component: Component, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const spec = COMPONENT_SPECS[component.type];
  if (!spec) return diagnostics;
  for (const pinName of spec.required_pins ?? []) {
    if (!component.pins.has(pinName)) {
      diagnostics.push(
        builder.make("error", "registry", "MISSING_REQUIRED_PIN", `Component ${component.id} is missing required pin ${pinName}.`, {
          relatedElements: [component.id, pinName],
        }),
      );
    }
  }
  if (spec.value_required && !component.value) {
    diagnostics.push(
      builder.make("error", "registry", "MISSING_REQUIRED_VALUE", `Component ${component.id} requires a <value>.`, {
        relatedElements: [component.id],
      }),
    );
  }
  for (const propertyName of spec.required_properties ?? []) {
    if (!component.properties.has(propertyName)) {
      diagnostics.push(
        builder.make(
          "error",
          "registry",
          "MISSING_REQUIRED_PROPERTY",
          `Component ${component.id} requires property ${propertyName}.`,
          { relatedElements: [component.id, propertyName] },
        ),
      );
    }
  }
  const requiredAny = spec.required_any ?? [];
  if (requiredAny.length > 0) {
    const satisfied = requiredAny.some(
      (name) => (name === "value" && component.value) || component.properties.has(name),
    );
    if (!satisfied) {
      diagnostics.push(
        builder.make(
          "error",
          "registry",
          "MISSING_REQUIRED_VALUE_OR_PROPERTY",
          `Component ${component.id} requires one of: ${requiredAny.join(", ")}.`,
          { relatedElements: [component.id] },
        ),
      );
    }
  }
  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_generic_load                                                      //
// --------------------------------------------------------------------------- //

function validateGenericLoad(component: Component, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!component.value && !component.properties.has("current")) {
    diagnostics.push(
      builder.make(
        "warning",
        "electrical",
        "LOAD_CURRENT_UNSPECIFIED",
        `Generic load ${component.id} should define a value or current property.`,
        { relatedElements: [component.id] },
      ),
    );
  }
  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_load_budget                                                       //
// --------------------------------------------------------------------------- //

function validateLoadBudget(ir: SystemIR, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // net -> total current draw. Lookup-only (never iterated), so a plain object
  // cannot reorder anything observable.
  const netLoads: Record<string, number> = {};

  // Initialize loads from generic_load components. pins[0] is POSITIONAL
  // (Python `list(load.pins.values())[0]`): document order, which the pins Map
  // preserves for integer-like names like "2","1" (rework round 1 probe A4 --
  // a plain object would resolve pin "1" first and attribute the load to the
  // wrong net, silently suppressing RAIL_LOAD/SOURCE_OVERLOADED).
  for (const load of ir.components.values()) {
    if (load.type !== "generic_load") continue;
    const pins = [...load.pins.values()];
    if (pins.length === 0) continue;
    const net = pins[0]!.net;
    const currentStr = load.properties.get("current") || load.value;
    if (currentStr) {
      try {
        const current = parseQuantity(currentStr, "A");
        netLoads[net] = (netLoads[net] ?? 0.0) + current;
      } catch {
        // pass
      }
    }
  }

  // Propagate loads through regulators (LDOs).
  const regulators = [...ir.components.values()].filter((c) => c.type === "ldo");
  for (const regulator of regulators) {
    const outPin = regulator.pins.get("out");
    const inPin = regulator.pins.get("in");
    if (!outPin || !inPin) continue;

    const outCurrent = netLoads[outPin.net] ?? 0.0;
    const maxCurrentStr = regulator.properties.get("iout_max");
    if (maxCurrentStr) {
      try {
        const maxCurrent = parseQuantity(maxCurrentStr, "A");
        if (outCurrent > maxCurrent) {
          diagnostics.push(
            builder.make(
              "error",
              "power",
              "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT",
              `Loads on ${outPin.net} (${g3(outCurrent)}A) exceed regulator ${regulator.id} limit (${maxCurrentStr}).`,
              {
                relatedElements: [regulator.id, outPin.net],
                observed: { load_current: `${g3(outCurrent)}A` },
                expected: { max_current: maxCurrentStr },
              },
            ),
          );
        }
      } catch {
        // pass
      }
    }

    // Add output current + IQ to input net load.
    const iqStr = regulator.properties.get("iq") ?? "0";
    try {
      const iq = parseQuantity(iqStr, "A");
      const totalIn = outCurrent + iq;
      netLoads[inPin.net] = (netLoads[inPin.net] ?? 0.0) + totalIn;
    } catch {
      netLoads[inPin.net] = (netLoads[inPin.net] ?? 0.0) + outCurrent;
    }
  }

  // Validate against voltage sources. pins[0] positional again (see above).
  for (const source of [...ir.components.values()].filter((c) => c.type === "voltage_source")) {
    const pins = [...source.pins.values()];
    if (pins.length === 0) continue;
    const net = pins[0]!.net; // Usually the positive terminal
    const totalDraw = netLoads[net] ?? 0.0;
    const imaxStr = source.properties.get("i_max");
    if (imaxStr) {
      try {
        const imax = parseQuantity(imaxStr, "A");
        if (totalDraw > imax) {
          diagnostics.push(
            builder.make(
              "error",
              "power",
              "SOURCE_OVERLOADED",
              `Total current draw from ${source.id} (${g3(totalDraw)}A) exceeds limit (${imaxStr}).`,
              {
                relatedElements: [source.id, net],
                observed: { total_draw: `${g3(totalDraw)}A` },
                expected: { max_current: imaxStr },
              },
            ),
          );
        }
      } catch {
        // pass
      }
    }
  }

  return diagnostics;
}

// --------------------------------------------------------------------------- //
// _validate_adc_binding + _estimate_net_voltage                               //
// --------------------------------------------------------------------------- //

function validateAdcBinding(ir: SystemIR, binding: FirmwareBinding, builder: DiagnosticBuilder): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const component = ir.components.get(binding.component);
  if (!component || component.type !== "mcu" || !component.part || !(component.part in MCUS)) {
    return diagnostics;
  }
  const adc = (MCUS[component.part] as McuSpec).peripherals[binding.peripheral];
  if (!isDict(adc) || !("vref" in adc)) return diagnostics;
  let vref: number;
  try {
    vref = parseQuantity(String((adc as Record<string, unknown>)["vref"]), "V");
  } catch {
    return diagnostics;
  }
  const net = ir.nets.get(binding.net);
  if (!net) return diagnostics;
  const estimated = estimateNetVoltage(ir, binding.net);
  if (estimated !== null && estimated > vref) {
    const adcVref = String((adc as Record<string, unknown>)["vref"]);
    diagnostics.push(
      builder.make(
        "error",
        "electrical",
        "ADC_INPUT_EXCEEDS_VREF",
        `ADC binding ${binding.id} can expose ${binding.net} above ${adcVref}.`,
        {
          relatedElements: [binding.id, binding.net, binding.component],
          observed: { estimated_voltage: `${g6(estimated)}V` },
          expected: { max: adcVref },
          suggestedActions: ["Adjust divider values", "Bind ADC after a divider", "Use a higher ADC attenuation model"],
        },
      ),
    );
  }
  return diagnostics;
}

function estimateNetVoltage(ir: SystemIR, netId: string): number | null {
  // `known` is lookup-only (never iterated), so a plain object is safe here;
  // the component iteration below is Map-ordered because float ACCUMULATION
  // order (conductanceSum += ...) must match Python's document-order sum.
  const known: Record<string, number> = {};
  for (const net of ir.nets.values()) {
    if (net.role === "ground") {
      known[net.id] = 0.0;
    } else if (net.nominal_voltage) {
      try {
        known[net.id] = parseQuantity(net.nominal_voltage, "V");
      } catch {
        // pass
      }
    }
  }
  for (const component of ir.components.values()) {
    const outPin = component.pins.get("out");
    if (component.type === "ldo" && outPin && component.properties.get("vout")) {
      try {
        known[outPin.net] = parseQuantity(component.properties.get("vout") as string, "V");
      } catch {
        // pass
      }
    }
  }
  if (netId in known) return known[netId]!;
  // One-node divider estimate, enough for the MVP battery-sense case.
  let conductanceSum = 0.0;
  let weightedVoltage = 0.0;
  for (const component of ir.components.values()) {
    if (component.type !== "resistor" || !component.value || component.pins.size < 2) {
      continue;
    }
    const pins = [...component.pins.values()];
    const nets = [pins[0]!.net, pins[1]!.net];
    if (!nets.includes(netId)) continue;
    const other = nets[0] === netId ? nets[1]! : nets[0]!;
    if (!(other in known)) continue;
    let resistance: number;
    try {
      resistance = parseQuantity(component.value, "ohm");
    } catch {
      continue;
    }
    const conductance = 1.0 / resistance;
    conductanceSum += conductance;
    weightedVoltage += conductance * known[other]!;
  }
  return conductanceSum ? weightedVoltage / conductanceSum : null;
}
