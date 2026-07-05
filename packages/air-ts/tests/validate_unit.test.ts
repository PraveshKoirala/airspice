/**
 * Unit tests for the validation port's building blocks (issue #8: "each rule is
 * a typed function with a unit test beyond the corpus"). These pin the exact
 * behaviors parity depends on but the corpus does not isolate:
 *   - DiagnosticBuilder id sequencing + per-instance reset (the collision quirk),
 *   - hasErrors severity semantics,
 *   - the message-numeric formatting the load-budget / ADC rules emit,
 *   - registry merge (built-in fallback + file override) and SPICE builtin sets,
 *   - serialized diagnostics.json shape (sorted keys, success flag, trailing \n).
 */

import { describe, it, expect } from "vitest";
import {
  validate,
  validateAll,
  validateTree,
  buildTreeSchemaView,
  serializeDiagnostics,
  hasErrors,
  parseXml,
  MCUS,
  COMPONENT_SPECS,
  PASSIVE_TYPES,
  SUPPORTED_SPICE_TYPES,
  BUILTIN_SPICE_MODELS,
  BUILTIN_SPICE_SUBCKTS,
} from "../src/index.js";
import { DiagnosticBuilder } from "../src/validate/diagnostics.js";
import { formatG } from "../src/format.js";

describe("DiagnosticBuilder", () => {
  it("assigns zero-padded sequential ids per instance", () => {
    const b = new DiagnosticBuilder();
    const d1 = b.make("error", "schema", "A", "m1");
    const d2 = b.make("warning", "schema", "B", "m2");
    expect(d1.id).toBe("diag_00001");
    expect(d2.id).toBe("diag_00002");
  });

  it("resets the counter for a fresh instance (the tree/ir collision quirk)", () => {
    // PARITY: validate_tree and validate_ir use SEPARATE builders, so both start
    // at diag_00001 -- ids collide if both emit. This test locks that behavior.
    const b1 = new DiagnosticBuilder();
    const b2 = new DiagnosticBuilder();
    expect(b1.make("error", "s", "A", "m").id).toBe("diag_00001");
    expect(b2.make("error", "s", "B", "m").id).toBe("diag_00001");
  });

  it("defaults optional fields to empty collections", () => {
    const d = new DiagnosticBuilder().make("info", "d", "C", "m");
    expect(d.related_elements).toEqual([]);
    expect(d.observed).toEqual({});
    expect(d.expected).toEqual({});
    expect(d.suggested_actions).toEqual([]);
  });
});

describe("hasErrors", () => {
  const mk = (severity: "info" | "warning" | "error") =>
    new DiagnosticBuilder().make(severity, "d", "C", "m");
  it("is true iff any diagnostic is an error", () => {
    expect(hasErrors([])).toBe(false);
    expect(hasErrors([mk("warning"), mk("info")])).toBe(false);
    expect(hasErrors([mk("warning"), mk("error")])).toBe(true);
  });
});

describe("message-numeric formatting parity (%.3g / %.6g)", () => {
  // These are the exact renderings the SOURCE_OVERLOADED / RAIL_LOAD / ADC
  // messages produce; a divergence here breaks byte-parity on the failing
  // corpus fixtures.
  it("%.3g matches the oracle for the phase3 overload value", () => {
    expect(formatG(0.201, 3)).toBe("0.201");
  });
  it("%.3g strips trailing zeros like Python", () => {
    expect(formatG(0.5, 3)).toBe("0.5");
    expect(formatG(2, 3)).toBe("2");
  });
  it("%.6g renders a divider voltage estimate", () => {
    expect(formatG(4.4, 6)).toBe("4.4");
  });
});

describe("registry (compiled-in, built-in fallback semantics)", () => {
  it("merges built-ins with on-disk registry files", () => {
    // ESP32-C3 / WROOM-32 exist as built-ins AND files (file wins, identical here);
    // STM32F103 comes from a file only.
    expect(Object.keys(MCUS).sort()).toEqual(["ESP32-C3", "ESP32-WROOM-32", "STM32F103"]);
  });
  it("component specs cover the built-in types plus registry files", () => {
    for (const t of ["resistor", "capacitor", "voltage_source", "current_source", "generic_load", "ldo", "mosfet", "diode", "bjt", "mcu"]) {
      expect(COMPONENT_SPECS[t], `spec for ${t}`).toBeDefined();
    }
  });
  it("PASSIVE_TYPES and SUPPORTED_SPICE_TYPES match the oracle sets", () => {
    expect([...PASSIVE_TYPES].sort()).toEqual(["capacitor", "resistor"]);
    expect([...SUPPORTED_SPICE_TYPES].sort()).toEqual([
      "bjt", "capacitor", "current_source", "diode", "generic_load", "ldo", "mosfet", "resistor", "voltage_source",
    ]);
  });
  it("MCU pins are arrays; power_pins keyed by pin name", () => {
    const c3 = MCUS["ESP32-C3"]!;
    expect(Object.keys(c3.power_pins)).toEqual(["3V3", "GND"]);
    expect(c3.pins["GPIO0"]).toEqual(["GPIO", "ADC1_CH0", "GPIO_OUT"]);
    expect(c3.peripherals["ADC1"]!.vref).toBe("3.3V");
  });
  it("SPICE builtin model/subckt sets match spice.py", () => {
    expect([...BUILTIN_SPICE_MODELS].sort()).toEqual(["D", "NMOS", "NPN", "PMOS", "PNP"]);
    expect([...BUILTIN_SPICE_SUBCKTS]).toEqual([]);
  });
});

describe("serializeDiagnostics shape", () => {
  it("emits {success, diagnostics} with sorted keys and a trailing newline", () => {
    const out = serializeDiagnostics([]);
    expect(out).toBe('{\n  "diagnostics": [],\n  "success": true\n}\n');
  });
  it("success is false when any error is present", () => {
    const root = parseXml('<system name="x" ir_version="0.1"><metadata/><nets><net id="g" role="signal"/></nets><components/><tests/><simulation_profiles/></system>');
    // Hand-built minimal IR (model collections are Maps; see model.ts).
    const diags = validateAll(root, {
      nets: new Map(),
      components: new Map(),
      power_domains: new Map(),
      analog: [],
      interfaces: new Map(),
      firmware_projects: new Map(),
      firmware_bindings: new Map(),
      firmware_tasks: new Map(),
      tests: new Map(),
      simulation_profiles: new Map(),
      bridges: [],
      exports: [],
      requirements: [],
      name: "x",
      ir_version: "0.1",
      metadata: { title: "", description: "", author: "", created_at: "" },
    });
    // No nets in the (hand-built minimal) ir -> NO_NETS + MISSING_GROUND errors.
    expect(hasErrors(diags)).toBe(true);
    expect(serializeDiagnostics(diags)).toContain('"success": false');
  });
});

describe("validateTree over a clean root emits nothing (corpus invariant)", () => {
  it("a well-formed <system> with all sections and unique ids is clean", () => {
    const root = parseXml('<system name="x" ir_version="0.1"><metadata/><nets><net id="g" role="ground"/></nets><components/><tests/><simulation_profiles/></system>');
    expect(validateTree(buildTreeSchemaView(root))).toEqual([]);
  });
});

describe("validate() end-to-end returns an ordered diagnostic list", () => {
  it("a clean design yields []", () => {
    const clean = '<system name="x" ir_version="0.1"><metadata/><nets><net id="g" role="ground"/></nets><components/><tests/><simulation_profiles/></system>';
    expect(validate(clean)).toEqual([]);
  });
});
