/**
 * Issue #36 - air-ts parity for the IR `<firmware><source>` inline-MicroPython
 * block. TEST-FIRST / HERMETIC: authored against the PRD contract before any
 * implementation exists, exercising the REAL air-ts public API (parse /
 * canonicalize / validate) - no mocks.
 *
 * The Python oracle (tests/test_firmware_source.py) is the objective contract;
 * air-ts must satisfy the SAME observable behavior:
 *   - canonical emit wraps the source in `<![CDATA[ ... ]]>` (never XML-escaped),
 *     with a literal `]]>` split-escaped as `]]]]><![CDATA[>`;
 *   - the source payload survives parse -> canonical -> parse BYTE-EXACT
 *     (tabs, trailing spaces, blank lines, `<`, `&`, unicode all preserved);
 *   - validation emits, with severity "error" (docs/diagnostics_spec.md: NEW
 *     codes are namespaced PREFIX-###; firmware validation is the VAL- bucket):
 *       VAL-001  (mcu ref to a missing component)
 *       VAL-002  (mcu ref to a non-MCU component)
 *       VAL-003  (a declared pin id absent from the MCU registry);
 *       the `pins` manifest uses registry pin IDs (the same `GPIO4` spelling as
 *       <pin name="GPIO4"/> and MCUS[part].pins keys) -- a declared pin id `X`
 *       is present iff the registry defines pin id `X` (no bare-number mapping).
 *       ESP32-C3 -> GPIO0..5, so pins="GPIO4,GPIO5" clean, pins="GPIO4,GPIO99"
 *       flags GPIO99 (the MicroPython body still calls Pin(4)/Pin(5) -- runtime);
 *   - a clean design trips none of those, and an existing declarative-firmware
 *     design (no <source>) is unchanged.
 *
 * PROVENANCE: the input designs in tests/fixtures/firmware_source.json are the
 * SAME byte-for-byte fixtures the Python suite consumes (tester-authored inputs
 * encoding the PRD; the new-block oracle output does not yet exist to capture).
 * Full-document byte-identity to the Python canonical is additionally closed by
 * the builder adding the 3 firmware-source corpus designs (PRD deliverable 5),
 * which the existing parity harness (parity.test.ts) diffs automatically.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalize, validate } from "../src/index.js";
import { parseXml, find, elementText } from "../src/xml.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const FIXTURES = JSON.parse(
  readFileSync(join(HERE, "fixtures", "firmware_source.json"), "utf-8"),
) as Record<string, string>;

const EXISTING_DECLARATIVE_DESIGN = join(
  HERE,
  "..",
  "..",
  "..",
  "examples",
  "esp32_battery_sensor",
  "design.air.xml",
);

// Contract codes (must match tests/test_firmware_source.py): namespaced VAL-.
const VAL_MCU_UNDEFINED = "VAL-001"; // mcu references a missing component
const VAL_MCU_NOT_MCU = "VAL-002"; // mcu references a non-MCU component
const VAL_PIN_NOT_ON_MCU = "VAL-003"; // a declared pin id is absent from the MCU registry
const NEW_FIRMWARE_CODES = new Set([
  VAL_MCU_UNDEFINED,
  VAL_MCU_NOT_MCU,
  VAL_PIN_NOT_ON_MCU,
]);

/** Byte-exact `<firmware><source>` payload, extracted engine-agnostically by
 *  re-parsing (CDATA resolves to text, exactly like ElementTree `.text`). */
function sourceText(xml: string): string {
  const root = parseXml(xml);
  const firmware = find(root, "firmware");
  expect(firmware, "design must have a <firmware> element").not.toBeNull();
  const source = find(firmware!, "source");
  expect(source, "firmware must have a <source> element").not.toBeNull();
  return elementText(source!);
}

/** (code, severity) pairs from the real validator. */
function diagPairs(xml: string): Set<string> {
  return new Set(validate(xml).map((d) => `${d.code}:${d.severity}`));
}

function errorCodes(xml: string): Set<string> {
  return new Set(validate(xml).filter((d) => d.severity === "error").map((d) => d.code));
}

// ============================ parse + canonical ============================
describe("firmware <source> parse + canonical (air-ts)", () => {
  it("a design with a <firmware><source> block parses and keeps the body", () => {
    const src = sourceText(FIXTURES.clean_plant_waterer);
    expect(src).toContain("adc.read_u16()");
  });

  it("canonical emit wraps the source in a CDATA section (not escaped text)", () => {
    const canon = canonicalize(FIXTURES.clean_plant_waterer);
    expect(canon).toContain("<![CDATA[");
    expect(canon).toContain("mv < 1200");
    expect(canon).not.toContain("mv &lt; 1200");
  });

  it("parse -> canonical -> parse preserves a clean payload byte-exact", () => {
    const xml = FIXTURES.clean_plant_waterer;
    expect(sourceText(canonicalize(xml))).toBe(sourceText(xml));
  });

  it("preserves the torture payload byte-exact (]]> tab trailing-space blank-line unicode)", () => {
    const xml = FIXTURES.escape_torture;
    const expected = sourceText(xml);
    // sanity: the fixture really carries the torture characters
    expect(expected).toContain("]]>");
    expect(expected).toContain("\t");
    expect(expected).toContain("\n\n"); // a genuine blank line inside the source
    expect(expected).toMatch(/µ/);
    expect(expected).toMatch(/°/);
    expect(expected).toMatch(/→/);
    expect(expected).toContain(" \n"); // trailing whitespace before a newline
    expect(sourceText(canonicalize(xml))).toBe(expected);
  });

  it("split-escapes a literal ]]> inside CDATA on emit", () => {
    const canon = canonicalize(FIXTURES.escape_torture);
    expect(canon).toContain("<![CDATA[");
    expect(canon).toContain("]]]]><![CDATA[>");
    expect(sourceText(canon)).toContain("]]>");
  });

  it("canonicalization is idempotent for the torture design", () => {
    const once = canonicalize(FIXTURES.escape_torture);
    expect(canonicalize(once)).toBe(once);
  });
});

// ================================ validation ================================
describe("firmware <source> validation (air-ts)", () => {
  it("a bad mcu ref emits VAL-001 (error)", () => {
    expect(diagPairs(FIXTURES.bad_mcu_ref)).toContain(`${VAL_MCU_UNDEFINED}:error`);
  });

  it("an mcu ref to a non-MCU component emits VAL-002 (error)", () => {
    expect(diagPairs(FIXTURES.mcu_not_mcu)).toContain(`${VAL_MCU_NOT_MCU}:error`);
  });

  it("a declared pin absent from the MCU emits VAL-003 (error)", () => {
    expect(diagPairs(FIXTURES.bad_pin_not_on_mcu)).toContain(`${VAL_PIN_NOT_ON_MCU}:error`);
  });

  it("a clean design trips none of the new firmware-source rules", () => {
    const codes = errorCodes(FIXTURES.clean_plant_waterer);
    for (const c of NEW_FIRMWARE_CODES) expect(codes).not.toContain(c);
    // and no error-severity diagnostics at all
    expect(validate(FIXTURES.clean_plant_waterer).some((d) => d.severity === "error")).toBe(false);
  });
});

// ============================== backward compat ==============================
describe("existing declarative firmware is unchanged (air-ts)", () => {
  const existing = readFileSync(EXISTING_DECLARATIVE_DESIGN, "utf-8");

  it("still validates clean and emits none of the new codes", () => {
    const diags = validate(existing);
    expect(diags.some((d) => d.severity === "error")).toBe(false);
    const codes = new Set(diags.map((d) => d.code));
    for (const c of NEW_FIRMWARE_CODES) expect(codes).not.toContain(c);
  });

  it("its canonical form has no CDATA section (source-only new emit path)", () => {
    expect(canonicalize(existing)).not.toContain("<![CDATA[");
  });
});
