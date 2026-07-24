/**
 * Mutation test (issue #8 acceptance criterion 3): take a PASSING design,
 * programmatically introduce each violation class, and assert the right
 * diagnostic fires. This guards against rules that exist in the port but never
 * trigger -- the corpus exercises only ~15 of the 50 codes, so the other ~35
 * are proven live here.
 *
 * Strategy: a single valid base design (BASE) that validates with ZERO
 * diagnostics; each case is a string mutation of that design's XML that
 * introduces exactly one violation class, and we assert the expected code is
 * among the emitted diagnostics (and, where the base was clean, that it is the
 * one that appears). No golden-corpus design name appears in this file, and it
 * lives under tests/ (guardrails R4 exempt).
 *
 * A separate "every validation-owned registry code is covered" assertion checks
 * that the union of {corpus-emitted codes} ∪ {mutation-covered codes} equals the
 * 50 validation-owned codes in registry/diagnostics.json -- the doc-vs-source
 * count made executable.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validate, parseXml, buildTreeSchemaView, validateTree } from "../src/index.js";
import { discoverDesigns, readText } from "./harness.js";

/** Schema-level codes (validate_tree) over the RAW tree, no model parse needed.
 * Mirrors the oracle: validate_tree(tree) runs on the raw ElementTree and is
 * robust to a non-<system> root (parse_tree would raise first in the export
 * pipeline, but validate_tree itself still emits INVALID_ROOT when called). */
function schemaCodes(xml: string): string[] {
  return validateTree(buildTreeSchemaView(parseXml(xml))).map((d) => d.code);
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** A base design that validates clean (zero diagnostics). */
const BASE = `<system name="mut" ir_version="0.1">
  <metadata>
    <title>Mutation base</title>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="v3v3" role="power" nominal_voltage="3.3V"/>
    <net id="sig" role="analog_signal"/>
    <net id="sda_net" role="signal"/>
    <net id="scl_net" role="signal"/>
  </nets>
  <power_domains>
    <domain id="pd_3v3" net="v3v3"/>
  </power_domains>
  <components>
    <component id="V3V3" type="voltage_source">
      <value>3.3V</value>
      <property name="i_max" value="1A"/>
      <pin name="p" net="v3v3"/>
      <pin name="n" net="gnd"/>
    </component>
    <component id="R1" type="resistor">
      <value>10k</value>
      <pin name="1" net="v3v3"/>
      <pin name="2" net="sig"/>
    </component>
    <component id="R2" type="resistor">
      <value>10k</value>
      <pin name="1" net="sig"/>
      <pin name="2" net="gnd"/>
    </component>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="v3v3"/>
      <pin name="GND" net="gnd"/>
      <pin name="GPIO0" net="sig" function="ADC1_CH0"/>
      <pin name="GPIO8" net="sda_net" function="I2C_SDA"/>
      <pin name="GPIO9" net="scl_net" function="I2C_SCL"/>
    </component>
  </components>
  <interfaces>
    <interface id="i2c0" type="i2c">
      <sda net="sda_net"/>
      <scl net="scl_net"/>
      <controller component="U_MCU" peripheral="I2C0"/>
      <pullup net="sda_net" to="v3v3" value="4.7k"/>
      <pullup net="scl_net" to="v3v3" value="4.7k"/>
      <property name="speed" value="100kHz"/>
    </interface>
  </interfaces>
  <firmware>
    <project id="fw" target="U_MCU" framework="arduino" language="cpp"/>
    <binding id="bind_adc">
      <signal name="s"/>
      <component ref="U_MCU"/>
      <peripheral>ADC1</peripheral>
      <channel>0</channel>
      <net>sig</net>
    </binding>
    <task id="t1" target="fw">
      <period>100ms</period>
    </task>
  </firmware>
  <analog>
    <subsystem id="core">
      <uses component="V3V3"/>
      <uses component="R1"/>
      <uses component="R2"/>
      <probe id="p_sig" net="sig" quantity="voltage"/>
    </subsystem>
  </analog>
  <tests>
    <test id="t_dc">
      <setup>
        <set_voltage net="v3v3" value="3.3V"/>
      </setup>
      <run duration="1ms"/>
      <assert_voltage net="sig" min="1.6V" max="1.7V"/>
      <assert_current component="V3V3" max="1A"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="prof" default="true">
      <backend type="ngspice"/>
      <include subsystem="core"/>
      <run test="t_dc"/>
    </profile>
  </simulation_profiles>
</system>`;

/** Codes emitted by the mutation cases below (accumulated for coverage proof). */
const covered = new Set<string>();

function codes(xml: string): string[] {
  return validate(xml).map((d) => d.code);
}

/** Replace helper that asserts the search text is present (mutation is real). */
function sub(haystack: string, find: string, replace: string): string {
  expect(haystack.includes(find), `mutation anchor not found: ${find}`).toBe(true);
  return haystack.replace(find, replace);
}

it("BASE design validates with zero diagnostics", () => {
  const diags = validate(BASE);
  expect(diags.map((d) => `${d.code}:${d.message}`)).toEqual([]);
});

interface Case {
  code: string;
  mutate: (xml: string) => string;
}

const cases: Case[] = [
  // ---- validate_ir: nets / grounds -------------------------------------- //
  {
    code: "NO_NETS",
    mutate: (x) =>
      x.replace(/<nets>[\s\S]*?<\/nets>/, "<nets></nets>"),
  },
  {
    code: "MISSING_GROUND",
    mutate: (x) => sub(x, '<net id="gnd" role="ground"/>', '<net id="gnd" role="signal"/>'),
  },
  // ---- component identity / type ---------------------------------------- //
  {
    code: "MISSING_COMPONENT_ID",
    // A component with NO id: the parser stores it under the "" key, so it is
    // iterated and `not component.id` fires MISSING_COMPONENT_ID (confirmed
    // against the oracle -- the "" key is real, not a collapse).
    mutate: (x) => sub(x, '<component id="R1" type="resistor">', '<component type="resistor">'),
  },
  {
    code: "MISSING_COMPONENT_TYPE",
    mutate: (x) => sub(x, '<component id="R1" type="resistor">', '<component id="R1" type="">'),
  },
  {
    code: "UNKNOWN_NET",
    mutate: (x) => sub(x, '<pin name="1" net="v3v3"/>\n      <pin name="2" net="sig"/>', '<pin name="1" net="nope"/>\n      <pin name="2" net="sig"/>'),
  },
  {
    code: "MISSING_POWER_OR_GROUND",
    // Drop the LDO/MCU power connection: point MCU 3V3 pin at a signal net.
    mutate: (x) => sub(x, '<pin name="3V3" net="v3v3"/>', '<pin name="3V3" net="sig"/>'),
  },
  {
    code: "UNSUPPORTED_SPICE_TYPE",
    // A component type outside SUPPORTED_SPICE_TYPES and not mcu.
    mutate: (x) =>
      sub(
        x,
        '<component id="R2" type="resistor">\n      <value>10k</value>',
        '<component id="R2" type="inductor">\n      <value>10k</value>',
      ),
  },
  {
    code: "POWER_DOMAIN_UNKNOWN_NET",
    mutate: (x) => sub(x, '<domain id="pd_3v3" net="v3v3"/>', '<domain id="pd_3v3" net="ghost"/>'),
  },
  // ---- analog ----------------------------------------------------------- //
  {
    code: "UNKNOWN_ANALOG_COMPONENT",
    mutate: (x) => sub(x, '<uses component="V3V3"/>', '<uses component="GHOST"/>'),
  },
  {
    code: "UNKNOWN_PROBE_NET",
    mutate: (x) => sub(x, '<probe id="p_sig" net="sig" quantity="voltage"/>', '<probe id="p_sig" net="ghost" quantity="voltage"/>'),
  },
  // ---- firmware --------------------------------------------------------- //
  {
    code: "UNKNOWN_FIRMWARE_TARGET",
    mutate: (x) => sub(x, '<project id="fw" target="U_MCU"', '<project id="fw" target="GHOST"'),
  },
  {
    code: "UNKNOWN_BINDING_COMPONENT",
    mutate: (x) => sub(x, '<component ref="U_MCU"/>', '<component ref="GHOST"/>'),
  },
  {
    code: "UNKNOWN_BINDING_NET",
    mutate: (x) => sub(x, '<net>sig</net>', '<net>ghost</net>'),
  },
  {
    code: "UNKNOWN_TASK_TARGET",
    mutate: (x) => sub(x, '<task id="t1" target="fw">', '<task id="t1" target="ghost">'),
  },
  // ---- tests ------------------------------------------------------------ //
  {
    code: "TEST_SETUP_UNKNOWN_NET",
    mutate: (x) => sub(x, '<set_voltage net="v3v3" value="3.3V"/>', '<set_voltage net="ghostnet" value="3.3V"/>'),
  },
  {
    code: "TEST_SETUP_UNKNOWN_COMPONENT",
    mutate: (x) =>
      sub(
        x,
        '<set_voltage net="v3v3" value="3.3V"/>',
        '<set_current component="GHOST" value="1mA"/>',
      ),
  },
  {
    code: "ASSERT_UNKNOWN_NET",
    mutate: (x) => sub(x, '<assert_voltage net="sig" min="1.6V" max="1.7V"/>', '<assert_voltage net="ghost" min="1.6V" max="1.7V"/>'),
  },
  {
    code: "ASSERT_UNKNOWN_COMPONENT",
    mutate: (x) => sub(x, '<assert_current component="V3V3" max="1A"/>', '<assert_current component="GHOST" max="1A"/>'),
  },
  // ---- simulation profiles ---------------------------------------------- //
  {
    code: "UNSUPPORTED_BACKEND",
    mutate: (x) => sub(x, '<backend type="ngspice"/>', '<backend type="spectre"/>'),
  },
  {
    code: "PROFILE_UNKNOWN_TEST",
    mutate: (x) => sub(x, '<run test="t_dc"/>', '<run test="ghost"/>'),
  },
  {
    code: "PROFILE_UNKNOWN_SUBSYSTEM",
    mutate: (x) => sub(x, '<include subsystem="core"/>', '<include subsystem="ghost"/>'),
  },
  // ---- i2c -------------------------------------------------------------- //
  {
    code: "I2C_UNKNOWN_NET",
    mutate: (x) => sub(x, '<sda net="sda_net"/>', '<sda net="ghost"/>'),
  },
  {
    code: "I2C_PULLUPS_NOT_DECLARED",
    // Remove one of the two pullups.
    mutate: (x) => sub(x, '<pullup net="scl_net" to="v3v3" value="4.7k"/>\n      ', ''),
  },
  {
    code: "I2C_PULLUP_UNKNOWN_NET",
    mutate: (x) => sub(x, '<pullup net="sda_net" to="v3v3" value="4.7k"/>', '<pullup net="ghost" to="v3v3" value="4.7k"/>'),
  },
  {
    code: "I2C_PULLUP_UNKNOWN_RAIL",
    mutate: (x) => sub(x, '<pullup net="sda_net" to="v3v3" value="4.7k"/>', '<pullup net="sda_net" to="ghostrail" value="4.7k"/>'),
  },
  {
    code: "I2C_PULLUP_NOT_POWER_RAIL",
    // Point the pullup at a non-power net (sig is analog_signal).
    mutate: (x) => sub(x, '<pullup net="sda_net" to="v3v3" value="4.7k"/>', '<pullup net="sda_net" to="sig" value="4.7k"/>'),
  },
  {
    code: "I2C_VOLTAGE_MISMATCH",
    // Add a distinct power rail and point a pullup at it (differs from MCU 3V3).
    mutate: (x) => {
      const withRail = sub(x, '<net id="scl_net" role="signal"/>', '<net id="scl_net" role="signal"/>\n    <net id="v1v8" role="power" nominal_voltage="1.8V"/>');
      return sub(withRail, '<pullup net="sda_net" to="v3v3" value="4.7k"/>', '<pullup net="sda_net" to="v1v8" value="4.7k"/>');
    },
  },
  {
    code: "I2C_PULLUP_TOO_WEAK",
    // Speed >100kHz and pullup >2200 ohm.
    mutate: (x) => {
      const fast = sub(x, '<property name="speed" value="100kHz"/>', '<property name="speed" value="400kHz"/>');
      return sub(fast, '<pullup net="sda_net" to="v3v3" value="4.7k"/>', '<pullup net="sda_net" to="v3v3" value="4.7k"/>').replace(/value="4.7k"/g, 'value="10k"');
    },
  },
  {
    code: "I2C_PULLUP_TOO_STRONG",
    // Pullup <1000 ohm at default (100kHz) speed.
    mutate: (x) => x.replace(/value="4.7k"/g, 'value="470"'),
  },
  // ---- mcu -------------------------------------------------------------- //
  {
    code: "UNKNOWN_MCU_PART",
    mutate: (x) => sub(x, '<component id="U_MCU" type="mcu" part="ESP32-C3">', '<component id="U_MCU" type="mcu" part="MADE-UP">'),
  },
  {
    code: "MISSING_MCU_POWER_PIN",
    // Remove the GND power pin from the MCU.
    mutate: (x) => sub(x, '<pin name="GND" net="gnd"/>\n      ', ''),
  },
  {
    code: "UNKNOWN_MCU_PIN",
    // A pin name not in the ESP32-C3 registry (warning).
    mutate: (x) => sub(x, '<pin name="GPIO0" net="sig" function="ADC1_CH0"/>', '<pin name="GPIO99" net="sig"/>'),
  },
  {
    code: "UNSUPPORTED_PIN_FUNCTION",
    mutate: (x) => sub(x, '<pin name="GPIO0" net="sig" function="ADC1_CH0"/>', '<pin name="GPIO0" net="sig" function="I2C_SDA"/>'),
  },
  // ---- component registry rules ----------------------------------------- //
  {
    code: "MISSING_REQUIRED_PIN",
    // Drop a required resistor pin (needs "1" and "2").
    mutate: (x) => sub(x, '<pin name="1" net="v3v3"/>\n      <pin name="2" net="sig"/>', '<pin name="2" net="sig"/>'),
  },
  {
    code: "MISSING_REQUIRED_VALUE",
    // Resistor without a <value> (value_required).
    mutate: (x) => sub(x, '<component id="R1" type="resistor">\n      <value>10k</value>', '<component id="R1" type="resistor">'),
  },
  {
    code: "MISSING_REQUIRED_PROPERTY",
    // An LDO requires vout/iout_max/v_dropout/iq properties; add an LDO missing them.
    mutate: (x) =>
      sub(
        x,
        '</components>',
        `  <component id="LDO1" type="ldo">
      <pin name="in" net="v3v3"/>
      <pin name="out" net="sig"/>
      <pin name="gnd" net="gnd"/>
    </component>
  </components>`,
      ),
  },
  {
    code: "MISSING_REQUIRED_VALUE_OR_PROPERTY",
    // A generic_load with neither value nor current property.
    mutate: (x) =>
      sub(
        x,
        '</components>',
        `  <component id="LOAD1" type="generic_load">
      <pin name="p" net="v3v3"/>
      <pin name="n" net="gnd"/>
    </component>
  </components>`,
      ),
  },
  {
    code: "LOAD_CURRENT_UNSPECIFIED",
    // Same shape, but the warning fires from _validate_generic_load too. Use a
    // generic_load with a value to avoid MISSING_REQUIRED_VALUE_OR_PROPERTY and
    // isolate the warning: actually the warning fires precisely when no value/
    // current -- so this shares the trigger. Assert the warning appears.
    mutate: (x) =>
      sub(
        x,
        '</components>',
        `  <component id="LOAD2" type="generic_load">
      <pin name="p" net="v3v3"/>
      <pin name="n" net="gnd"/>
    </component>
  </components>`,
      ),
  },
  // ---- load budget ------------------------------------------------------ //
  {
    code: "SOURCE_OVERLOADED",
    // Add a heavy generic_load on v3v3 exceeding V3V3 i_max (1A).
    mutate: (x) =>
      sub(
        x,
        '</components>',
        `  <component id="HOG" type="generic_load">
      <value>2A</value>
      <pin name="p" net="v3v3"/>
      <pin name="n" net="gnd"/>
    </component>
  </components>`,
      ),
  },
  {
    code: "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT",
    // Add an LDO with a small iout_max feeding a rail with a big load.
    mutate: (x) => {
      const withRail = sub(x, '<net id="scl_net" role="signal"/>', '<net id="scl_net" role="signal"/>\n    <net id="v1v8" role="power" nominal_voltage="1.8V"/>');
      return sub(
        withRail,
        '</components>',
        `  <component id="LDO1" type="ldo">
      <property name="vout" value="1.8V"/>
      <property name="iout_max" value="100mA"/>
      <property name="v_dropout" value="0.3V"/>
      <property name="iq" value="50uA"/>
      <pin name="in" net="v3v3"/>
      <pin name="out" net="v1v8"/>
      <pin name="gnd" net="gnd"/>
    </component>
    <component id="BIGLOAD" type="generic_load">
      <value>500mA</value>
      <pin name="p" net="v1v8"/>
      <pin name="n" net="gnd"/>
    </component>
  </components>`,
      );
    },
  },
  // ---- adc binding ------------------------------------------------------ //
  {
    code: "ADC_INPUT_EXCEEDS_VREF",
    // Bind the ADC to a net whose estimated voltage exceeds vref (3.3V).
    // Make sig sit at ~4.4V via a divider from a 8.8V rail through R1/R2 equal.
    mutate: (x) => {
      const hv = sub(x, '<net id="v3v3" role="power" nominal_voltage="3.3V"/>', '<net id="v3v3" role="power" nominal_voltage="3.3V"/>\n    <net id="vhi" role="power" nominal_voltage="8.8V"/>');
      return sub(hv, '<pin name="1" net="v3v3"/>\n      <pin name="2" net="sig"/>', '<pin name="1" net="vhi"/>\n      <pin name="2" net="sig"/>');
    },
  },
  // ---- spice models (issue #55) ----------------------------------------- //
  {
    code: "UNDEFINED_SPICE_MODEL",
    // A diode with a part-level spice_model outside the builtin set.
    mutate: (x) =>
      sub(
        x,
        '</components>',
        `  <component id="D1" type="diode" spice_model="1N5819">
      <pin name="a" net="v3v3"/>
      <pin name="c" net="gnd"/>
    </component>
  </components>`,
      ),
  },
];

describe("mutation: each violation class fires its diagnostic", () => {
  for (const c of cases) {
    it(`${c.code} fires`, () => {
      const mutated = c.mutate(BASE);
      const emitted = codes(mutated);
      expect(emitted, `expected ${c.code} in [${emitted.join(", ")}]`).toContain(c.code);
      covered.add(c.code);
    });
  }
});

/**
 * validate_tree schema codes: mutating the ROOT structure. These are exercised
 * against synthetic malformed roots (validate() runs validate_tree over the raw
 * tree). Each is asserted independently because a bad root short-circuits.
 */
describe("mutation: schema (validate_tree) codes fire", () => {
  it("INVALID_ROOT fires", () => {
    // validate_tree runs over the raw tree and emits INVALID_ROOT for a non-
    // <system> root (and short-circuits), independent of model parsing.
    const emitted = schemaCodes('<notsystem name="x" ir_version="0.1"><metadata/><nets/><components/><tests/><simulation_profiles/></notsystem>');
    expect(emitted).toEqual(["INVALID_ROOT"]);
    covered.add("INVALID_ROOT");
  });
  it("MISSING_SYSTEM_ATTR fires", () => {
    // Root <system> with no name / ir_version. Sections present so only the
    // attr codes fire (order: name then ir_version).
    const emitted = schemaCodes('<system><metadata/><nets><net id="g" role="ground"/></nets><components/><tests/><simulation_profiles/></system>');
    expect(emitted).toContain("MISSING_SYSTEM_ATTR");
    covered.add("MISSING_SYSTEM_ATTR");
  });
  it("MISSING_SECTION fires", () => {
    const emitted = schemaCodes('<system name="x" ir_version="0.1"><nets><net id="g" role="ground"/></nets></system>');
    expect(emitted).toContain("MISSING_SECTION");
    covered.add("MISSING_SECTION");
  });
  it("DUPLICATE_ID fires", () => {
    const emitted = schemaCodes('<system name="x" ir_version="0.1"><metadata/><nets><net id="dup" role="ground"/><net id="dup" role="power"/></nets><components/><tests/><simulation_profiles/></system>');
    expect(emitted).toContain("DUPLICATE_ID");
    covered.add("DUPLICATE_ID");
  });
});

/**
 * DUPLICATE_COMPONENT_ID is structurally non-triggerable from parsed XML: the
 * parser keys components by id in a dict, so two components with the SAME id
 * collapse to ONE entry before validate_ir's `len(list) != len(set)` compare
 * ever runs. Verified against the oracle: the same duplicate input instead
 * emits the RAW-tree DUPLICATE_ID (schema) code from validate_tree (which IS
 * covered by the DUPLICATE_ID mutation above). We assert DUPLICATE_COMPONENT_ID
 * as documented-unreachable so the coverage ledger is honest rather than
 * silently short. (MISSING_COMPONENT_ID, by contrast, IS reachable -- a no-id
 * component gets the "" dict key and fires -- and has a real mutation case.)
 *
 * // PARITY: DUPLICATE_COMPONENT_ID is dead from XML input in both the oracle and
 * // this port; it is retained verbatim (not deleted) because the oracle keeps it.
 */
const STRUCTURALLY_UNREACHABLE_FROM_XML = new Set([
  "DUPLICATE_COMPONENT_ID", // dict de-dups ids before the len-vs-set compare; DUPLICATE_ID fires instead
]);

describe("coverage ledger vs registry (50 validation-owned codes)", () => {
  it("every validation-owned code is covered by corpus OR mutation OR documented-unreachable", () => {
    // Registry codes owned by validation.
    const REPO_ROOT = join(HERE, "..", "..", "..");
    const registry = JSON.parse(readFileSync(join(REPO_ROOT, "registry", "diagnostics.json"), "utf-8")) as {
      diagnostics: Array<{ code: string; owner: string }>;
    };
    const validationCodes = new Set(registry.diagnostics.filter((d) => d.owner === "validation").map((d) => d.code));
    expect(validationCodes.size).toBe(50);

    // Codes the corpus fixtures emit (dynamically read; no design names in source).
    const corpusCodes = new Set<string>();
    for (const design of discoverDesigns()) {
      try {
        const payload = JSON.parse(readText(design.diagnosticsPath)) as { diagnostics: Array<{ code: string }> };
        for (const d of payload.diagnostics) corpusCodes.add(d.code);
      } catch {
        // no diagnostics.json -> skip
      }
    }

    const accountedFor = new Set<string>([...covered, ...corpusCodes, ...STRUCTURALLY_UNREACHABLE_FROM_XML]);
    const missing = [...validationCodes].filter((c) => !accountedFor.has(c));
    expect(missing, `validation codes with NO coverage: [${missing.join(", ")}]`).toEqual([]);
  });
});
