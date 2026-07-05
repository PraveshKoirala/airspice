/**
 * Repair benchmark cases (issue #19 deliverable 3).
 *
 * Every `examples/failing/*.air.xml` is one case. THIS FILE IS THE BENCHMARK
 * FIXTURE, not product code — it lives under bench/ precisely so it MAY name the
 * example designs (the loop code + prompts must not; a `grep -ri "bad_adc"` in
 * loop/prompt code = cheating, but a bench case list naming its inputs is the
 * benchmark doing its job). The scored loop under test (repair/loop.ts) is fully
 * general and knows nothing about these names.
 *
 * MOCK MODE (CI): each case carries a `scriptedFix` — a deterministic AIR <patch>
 * that, applied through the REAL air-ts gate, makes the design validate. The mock
 * provider replays it; the loop applies it through the gate exactly as a real
 * model's patch would be applied. This validates the loop MECHANICS end to end
 * (context assembly → gate → apply → re-evaluate → stop) with zero network.
 *
 * The scripted fixes were each verified to yield 0 validation errors through
 * air-ts `applyPatch` + `validate` (see the loop mechanics test). They are the
 * "known-good answer" the mock plays back — the loop still has to DRIVE the whole
 * simulate→diagnose→patch→re-simulate cycle and reach the `fixed` stop condition.
 *
 * LIVE MODE (local): the scripted fix is IGNORED; a real provider proposes its
 * own patch. Only the design + the pass criterion (validate + sim) are used.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One benchmark case: a failing design + the mock's known-good scripted fix. */
export interface BenchCase {
  /** The example's file stem (its case id). */
  readonly name: string;
  /** The failing design's AIR XML (read from examples/failing/). */
  readonly designXml: string;
  /**
   * A deterministic AIR <patch> that repairs this design (MOCK MODE only). In
   * live mode the provider proposes its own fix and this is unused.
   */
  readonly scriptedFix: string;
  /** A one-line human summary of the fix (the mock's patch summary). */
  readonly fixSummary: string;
}

/** The six failing examples, in a stable order. */
export const CASE_NAMES = [
  "bad_adc_divider",
  "i2c_without_pullups",
  "invalid_pin_function",
  "missing_ground",
  "overloaded_3v3_rail",
  "phase3_failure",
] as const;

/** The scripted mock fixes, keyed by case name (verified to validate clean). */
const SCRIPTED_FIXES: Record<string, { patch: string; summary: string }> = {
  bad_adc_divider: {
    summary: "Resize the divider so the ADC sense voltage stays under Vref.",
    patch:
      `<patch id="fix_adc"><reason>Resize divider so sense stays under Vref.</reason>` +
      `<replace path="/system/components/component[@id='R_TOP']/value"><value>1M</value></replace>` +
      `<replace path="/system/components/component[@id='R_BOTTOM']/value"><value>330k</value></replace>` +
      `</patch>`,
  },
  i2c_without_pullups: {
    summary: "Declare SDA and SCL pull-ups to the MCU's 3V3 rail.",
    patch:
      `<patch id="fix_i2c"><reason>Declare I2C pull-ups on the MCU rail.</reason>` +
      `<add path="/system/interfaces/interface[@id='i2c0']"><pullup net="sda" value="4.7k" to="3v3"/></add>` +
      `<add path="/system/interfaces/interface[@id='i2c0']"><pullup net="scl" value="4.7k" to="3v3"/></add>` +
      `</patch>`,
  },
  invalid_pin_function: {
    summary: "Move I2C_SDA to a pin that supports it.",
    patch:
      `<patch id="fix_pin"><reason>Use a pin that supports I2C_SDA.</reason>` +
      `<replace path="/system/components/component[@id='U_MCU']/pin[@name='GPIO4']">` +
      `<pin name="GPIO8" net="sda" function="I2C_SDA"/></replace>` +
      `</patch>`,
  },
  missing_ground: {
    summary: "Add a ground net and connect the MCU's GND pin.",
    patch:
      `<patch id="fix_gnd"><reason>Add ground net and MCU ground pin.</reason>` +
      `<add path="/system/nets"><net id="gnd" role="ground"/></add>` +
      `<add path="/system/components/component[@id='U_MCU']"><pin name="GND" net="gnd"/></add>` +
      `</patch>`,
  },
  overloaded_3v3_rail: {
    summary: "Raise the regulator current limit above the load draw.",
    patch:
      `<patch id="fix_rail"><reason>Raise the regulator current limit above the load.</reason>` +
      `<replace path="/system/components/component[@id='U_REG']/property[@name='iout_max']">` +
      `<property name="iout_max" value="900mA"/></replace>` +
      `</patch>`,
  },
  phase3_failure: {
    summary: "Raise the source current limit and correct the I2C pull-up rail.",
    patch:
      `<patch id="fix_p3"><reason>Raise source limit and correct pull-up rail.</reason>` +
      `<replace path="/system/components/component[@id='V_BAT']/property[@name='i_max']">` +
      `<property name="i_max" value="300mA"/></replace>` +
      `<replace path="/system/interfaces/interface[@id='i2c_bus']/pullup[@net='sda']">` +
      `<pullup net="sda" value="2.2k" to="3v3"/></replace>` +
      `<replace path="/system/interfaces/interface[@id='i2c_bus']/pullup[@net='scl']">` +
      `<pullup net="scl" value="2.2k" to="3v3"/></replace>` +
      `</patch>`,
  },
};

/** Resolve the examples/failing directory relative to this module. */
function exampleXml(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../examples/failing/${name}.air.xml`, import.meta.url)),
    "utf-8",
  );
}

/** Load every benchmark case (design + scripted fix). */
export function loadBenchCases(): BenchCase[] {
  return CASE_NAMES.map((name) => {
    const fix = SCRIPTED_FIXES[name];
    if (!fix) throw new Error(`bench: missing scripted fix for case '${name}'`);
    return {
      name,
      designXml: exampleXml(name),
      scriptedFix: fix.patch,
      fixSummary: fix.summary,
    };
  });
}
