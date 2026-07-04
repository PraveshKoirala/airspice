/**
 * Port of `packages/core/src/air/model_dump.py` (model_to_dict) plus the
 * exporter's `json.dumps(..., indent=2, sort_keys=True) + "\n"` framing.
 *
 * Determinism contract (from the module docstring + export_golden.py):
 *   - object keys are emitted in sorted order (handled by json.dumps sort_keys,
 *     which our `dumps` reproduces), so the manual dict sorting in the oracle is
 *     redundant for keys and we don't replicate it;
 *   - LISTS are emitted in a defined order and json.dumps does NOT reorder them,
 *     so we must sort them here exactly as the oracle does:
 *       analog            sorted by subsystem id
 *       analog[].uses     sorted (by string)
 *       analog[].probes   sorted by probe id
 *       bridges           sorted by id
 *       exports           sorted by target
 *       assertions/operations/backends/... preserve document order (NOT sorted)
 *   - components are keyed by id (a map -> sorted keys via dumps); each pins and
 *     properties sub-map is also a map -> sorted by dumps.
 *
 * All string sorts use Unicode-code-point order to match Python `sorted()`.
 */

import type { SystemIR } from "./model.js";
import { type JsonValue, dumps } from "./json.js";

/** Code-point (Python `sorted`) comparator for BMP strings. */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Build the deterministically-ordered plain object (model_to_dict). */
export function modelToObject(ir: SystemIR): JsonValue {
  const components: Record<string, JsonValue> = {};
  for (const cid of Object.keys(ir.components).sort(byCodePoint)) {
    const comp = ir.components[cid];
    if (comp === undefined) continue;
    // _plain(comp) then explicitly re-set pins/properties as sorted maps. Since
    // our `dumps` sorts every object's keys, plain object copies suffice; the
    // ordering is applied at serialization time.
    const pins: Record<string, JsonValue> = {};
    for (const pinName of Object.keys(comp.pins).sort(byCodePoint)) {
      const pin = comp.pins[pinName];
      if (pin === undefined) continue;
      pins[pinName] = {
        name: pin.name,
        net: pin.net,
        function: pin.function,
      };
    }
    const properties: Record<string, JsonValue> = {};
    for (const propName of Object.keys(comp.properties).sort(byCodePoint)) {
      properties[propName] = comp.properties[propName] as string;
    }
    components[cid] = {
      id: comp.id,
      type: comp.type,
      part: comp.part,
      spice_model: comp.spice_model,
      spice_subckt: comp.spice_subckt,
      value: comp.value,
      pins,
      properties,
    };
  }

  const analog: JsonValue[] = [];
  for (const sub of [...ir.analog].sort((a, b) => byCodePoint(a.id, b.id))) {
    analog.push({
      id: sub.id,
      uses: [...sub.uses].sort(byCodePoint),
      probes: [...sub.probes]
        .sort((a, b) => byCodePoint(a.id, b.id))
        .map((p) => ({ id: p.id, net: p.net, quantity: p.quantity })),
    });
  }

  const bridges: JsonValue[] = [...ir.bridges]
    .sort((a, b) => byCodePoint(a.id, b.id))
    .map((b) => ({ id: b.id, type: b.type, data: b.data as unknown as JsonValue }));

  const exports: JsonValue[] = [...ir.exports]
    .sort((a, b) => byCodePoint(a.target, b.target))
    .map((e) => ({ target: e.target, enabled: e.enabled }));

  return {
    name: ir.name,
    ir_version: ir.ir_version,
    metadata: { ...ir.metadata },
    requirements: ir.requirements.map((r) => ({ ...r })),
    nets: mapValues(ir.nets),
    power_domains: mapValues(ir.power_domains),
    components,
    interfaces: mapValues(ir.interfaces),
    analog,
    firmware_projects: mapValues(ir.firmware_projects),
    firmware_bindings: mapValues(ir.firmware_bindings),
    firmware_tasks: mapValues(ir.firmware_tasks),
    bridges,
    tests: mapValues(ir.tests),
    simulation_profiles: mapValues(ir.simulation_profiles),
    exports,
  };
}

/**
 * Serialize a SystemIR to the byte-exact `model.json` string (trailing newline
 * included).
 */
export function serializeModel(ir: SystemIR): string {
  return dumps(modelToObject(ir));
}

/**
 * Copy a Record<string, T> into a plain JsonValue object. Keys are emitted in
 * sorted order by `dumps`, so we do not pre-sort here. Values are structurally
 * cloned via JSON-compatible spread (the model holds only JSON-native data).
 */
function mapValues<T>(m: Record<string, T>): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = v as unknown as JsonValue;
  }
  return out;
}
