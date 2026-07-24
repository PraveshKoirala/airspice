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
  // Model collections are Maps (insertion-ordered; see model.ts). `dumps` sorts
  // Map keys exactly like object keys, so serialization output is unchanged.
  const components: Record<string, JsonValue> = {};
  for (const cid of [...ir.components.keys()].sort(byCodePoint)) {
    const comp = ir.components.get(cid);
    if (comp === undefined) continue;
    // _plain(comp) then explicitly re-set pins/properties as sorted maps. Since
    // our `dumps` sorts every object's keys, plain object copies suffice; the
    // ordering is applied at serialization time.
    const pins: Record<string, JsonValue> = {};
    for (const pinName of [...comp.pins.keys()].sort(byCodePoint)) {
      const pin = comp.pins.get(pinName);
      if (pin === undefined) continue;
      pins[pinName] = {
        name: pin.name,
        net: pin.net,
        function: pin.function,
      };
    }
    const properties: Record<string, JsonValue> = {};
    for (const propName of [...comp.properties.keys()].sort(byCodePoint)) {
      properties[propName] = comp.properties.get(propName) as string;
    }
    const componentObj: Record<string, JsonValue> = {
      id: comp.id,
      type: comp.type,
      part: comp.part,
      spice_model: comp.spice_model,
      spice_subckt: comp.spice_subckt,
      value: comp.value,
      pins,
      properties,
    };
    // OMIT-WHEN-NULL for the optional <gui> hint (issue #22): every pre-#22
    // corpus design has gui=null, and dropping the key entirely (rather
    // than emitting "gui": null) preserves byte-parity with the frozen
    // model.json fixtures. Same pattern as Test.analysis (#62).
    if (comp.gui !== null) {
      componentObj["gui"] = { x: comp.gui.x, y: comp.gui.y, rot: comp.gui.rot };
    }
    components[cid] = componentObj;
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

  const payload: Record<string, JsonValue> = {
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
    tests: testsMapValues(ir),
    simulation_profiles: mapValues(ir.simulation_profiles),
    exports,
  };
  // OMIT-WHEN-NULL for the optional inline firmware source (issue #36): every
  // design without a <firmware><source> block has firmware_source=null, and
  // dropping the key entirely (rather than emitting "firmware_source": null)
  // preserves byte-parity with the frozen model.json fixtures -- the same
  // pattern as Component.gui (#22) and Test.analysis (#62). `dumps` sorts keys,
  // so the position in this object is irrelevant. `pins` is a string[] -> JSON
  // array, mirroring the Python tuple rendered by model_dump._plain. The truthy
  // check treats both null and undefined (an omitted optional) as "absent".
  if (ir.firmware_source) {
    payload["firmware_source"] = {
      mcu: ir.firmware_source.mcu,
      language: ir.firmware_source.language,
      entry: ir.firmware_source.entry,
      pins: [...ir.firmware_source.pins],
      source: ir.firmware_source.source,
    };
  }
  return payload;
}

/**
 * Serialize the tests Map, omitting the ``analysis`` key on any Test whose
 * ``analysis`` is null (issue #62). The Python oracle does the same in
 * ``model_dump.model_to_dict`` -- a Test that never grew an <analysis> child
 * (i.e. every design in the pre-#62 corpus) dumps without the field at all so
 * the frozen model.json bytes are unchanged. A Test that DOES carry an AC
 * analysis serializes the nested object verbatim.
 */
function testsMapValues(ir: SystemIR): JsonValue {
  const out: Record<string, JsonValue> = {};
  for (const [testId, test] of ir.tests) {
    const testObj: Record<string, JsonValue> = {
      id: test.id,
      description: test.description,
      setup: test.setup as unknown as JsonValue,
      duration: test.duration,
      assertions: test.assertions as unknown as JsonValue,
    };
    if (test.analysis !== null) {
      testObj["analysis"] = { ...test.analysis };
    }
    out[testId] = testObj;
  }
  return out;
}

/**
 * Serialize a SystemIR to the byte-exact `model.json` string (trailing newline
 * included).
 */
export function serializeModel(ir: SystemIR): string {
  return dumps(modelToObject(ir));
}

/**
 * Pass a model Map through as a JsonValue. `dumps` serializes a Map exactly
 * like an object with sorted keys, and it recurses into nested Maps (a Test's
 * `setup`, a SimulationProfile's `properties`), so no per-field conversion is
 * needed and the emitted bytes are identical to the previous Record layout.
 */
function mapValues<T>(m: Map<string, T>): JsonValue {
  return m as unknown as JsonValue;
}
