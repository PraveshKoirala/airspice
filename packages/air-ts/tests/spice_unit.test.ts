/**
 * SPICE emitter unit tests (issue #9) -- the edge cases the parity corpus does
 * not exercise densely enough on its own:
 *   - node mangling / ground normalization (net named `gnd` vs role="ground" vs
 *     net named `0`, plus case-insensitivity and the "no other mangling" rule);
 *   - the post-#59 PULSE math (50 %, low-frequency, sub-edge triangle, edge-floor,
 *     0 %/100 %, a frequency sweep, and the never-negative-plateau invariant),
 *     mirroring tests/test_spice_pwm.py from the Python oracle;
 *   - the fixed `.model` card set;
 *   - analysis-line (`.tran`) construction from the test duration.
 *
 * Expected strings are the LITERAL bytes the live oracle emits (captured with a
 * throwaway `_pwm_pulse`/`_spice_net` driver against packages/core). Assertions
 * are byte-exact `toBe`, not tolerance -- byte parity is the criterion (#9).
 *
 * Emission is driven end-to-end through the parser (`parse` -> `compileSpice`)
 * so the tests exercise the same document-order Maps and value handling the
 * corpus path uses; the private `pwmPulse`/`spiceNet` helpers stay private.
 */

import { describe, expect, it } from "vitest";
import { parse } from "../src/index.js";
import {
  BUILTIN_MODEL_CARDS,
  compileSpice,
  type SpiceArtifacts,
} from "../src/emit/spice.js";
import type { SystemIR, Test } from "../src/model.js";

// --------------------------------------------------------------------------- //
// Helpers: build a minimal IR from XML and pull specific emitted lines out.    //
// --------------------------------------------------------------------------- //

function netlistLines(xml: string, test?: Test | null): string[] {
  const ir = parse(xml);
  const artifacts: SpiceArtifacts = compileSpice(ir, test ?? null);
  return artifacts.netlist.split("\n");
}

function firstTestOf(ir: SystemIR): Test | null {
  for (const t of ir.tests.values()) return t;
  return null;
}

/**
 * A firmware PWM design whose ON-time/period are templated in, so we can drive
 * `pwmPulse` through the real MCU-stimulus path and read the emitted PULSE card.
 */
function pwmStimCard(ton: string, period: string): string {
  const xml = `
<system name="pwm_emit" ir_version="0.1">
  <nets>
    <net id="gnd" role="ground"/>
    <net id="pwm" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="GND" net="gnd"/>
      <pin name="GPIO2" net="pwm" function="GPIO_OUT"/>
    </component>
  </components>
  <firmware>
    <project id="fw" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <task id="t" target="fw">
      <period>${period}</period>
      <write_gpio pin="GPIO2" value="high"/>
      <delay duration="${ton}"/>
      <write_gpio pin="GPIO2" value="low"/>
    </task>
  </firmware>
</system>`;
  const lines = netlistLines(xml);
  const stim = lines.filter((l) => l.startsWith("V_STIM_"));
  expect(stim, `expected exactly one V_STIM line, got ${JSON.stringify(stim)}`).toHaveLength(1);
  // Line shape: "V_STIM_U_MCU_GPIO2 pwm 0 <card...>" -- card is everything after
  // the 3rd space (the card itself may contain spaces).
  return stim[0]!.split(" ").slice(3).join(" ");
}

// --------------------------------------------------------------------------- //
// Ground normalization / node mangling                                         //
// --------------------------------------------------------------------------- //

describe("ground normalization and node mangling", () => {
  // A single resistor between two nets, so we can read the emitted node names
  // straight off the R_ card. pins declared p-then-n mirrors the corpus norm.
  function resistorNodes(netP: string, netN: string): [string, string] {
    const xml = `
<system name="t" ir_version="0.1">
  <nets>
    <net id="${netP}" role="power"/>
    <net id="${netN}" role="ground"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <pin name="p" net="${netP}"/>
      <pin name="n" net="${netN}"/>
      <value>10k</value>
    </component>
  </components>
</system>`;
    const line = netlistLines(xml).find((l) => l.startsWith("R_R1"));
    expect(line, "expected an R_R1 card").toBeDefined();
    const parts = line!.split(" ");
    return [parts[1]!, parts[2]!];
  }

  it("a net literally named `gnd` normalizes to `0`", () => {
    expect(resistorNodes("vin", "gnd")).toEqual(["vin", "0"]);
  });

  it("a net literally named `0` stays `0` (already ground)", () => {
    expect(resistorNodes("vin", "0")).toEqual(["vin", "0"]);
  });

  it("ground normalization is case-insensitive (`GND`, `GnD` -> `0`)", () => {
    expect(resistorNodes("vin", "GND")).toEqual(["vin", "0"]);
    expect(resistorNodes("vin", "GnD")).toEqual(["vin", "0"]);
  });

  it("a net whose id is `ground` (the ROLE word) is NOT normalized -- only `gnd`/`0` are", () => {
    // role="ground" on a net named `ground` must NOT collapse to `0`; the
    // GROUND_NAMES set is {gnd, 0}, keyed on the net id, never the role.
    expect(resistorNodes("vin", "ground")).toEqual(["vin", "ground"]);
  });

  it("non-ground node names pass through verbatim (no escaping/mangling)", () => {
    expect(resistorNodes("V_IN+", "3v3")).toEqual(["V_IN+", "3v3"]);
    expect(resistorNodes("net.with.dots", "GND_1")).toEqual(["net.with.dots", "GND_1"]);
  });
});

// --------------------------------------------------------------------------- //
// PULSE / PWM emission (post-#59) -- byte-exact against the live oracle          //
// --------------------------------------------------------------------------- //

describe("PWM PULSE emission (post-#59, byte-exact vs oracle)", () => {
  it("50% duty compensates the edges: 5us/10us -> PW 4us", () => {
    expect(pwmStimCard("5us", "10us")).toBe("PULSE(0 3.3 0 1us 1us 4us 10us)");
  });

  it("50% duty low frequency: 5ms/10ms -> PW 4.999ms (a corpus switch design's case)", () => {
    expect(pwmStimCard("5ms", "10ms")).toBe("PULSE(0 3.3 0 1us 1us 4.999ms 10ms)");
  });

  it("a frequency sweep emits the compensated plateau byte-for-byte", () => {
    expect(pwmStimCard("2us", "10us")).toBe("PULSE(0 3.3 0 1us 1us 1us 10us)");
    expect(pwmStimCard("8us", "10us")).toBe("PULSE(0 3.3 0 1us 1us 7us 10us)");
    expect(pwmStimCard("25us", "100us")).toBe("PULSE(0 3.3 0 1us 1us 24us 100us)");
    expect(pwmStimCard("500us", "1ms")).toBe("PULSE(0 3.3 0 1us 1us 499us 1ms)");
  });

  it("sub-edge on-time collapses to a triangle (PW `0s`, edges shrink to ton)", () => {
    // 300ns < 1us edge -> edges = 300ns, PW = 0s.
    expect(pwmStimCard("300ns", "1us")).toBe("PULSE(0 3.3 0 300ns 300ns 0s 1us)");
    expect(pwmStimCard("500ns", "10us")).toBe("PULSE(0 3.3 0 500ns 500ns 0s 10us)");
    expect(pwmStimCard("250ns", "10us")).toBe("PULSE(0 3.3 0 250ns 250ns 0s 10us)");
    expect(pwmStimCard("100ns", "1us")).toBe("PULSE(0 3.3 0 100ns 100ns 0s 1us)");
  });

  it("edge-floor exact: ton == 1us edge -> triangle with PW `0s`", () => {
    expect(pwmStimCard("1us", "10us")).toBe("PULSE(0 3.3 0 1us 1us 0s 10us)");
  });

  it("0% duty -> `DC 0`; 100% and >100% -> `DC 3.3`", () => {
    expect(pwmStimCard("0us", "10us")).toBe("DC 0");
    expect(pwmStimCard("10us", "10us")).toBe("DC 3.3");
    expect(pwmStimCard("20us", "10us")).toBe("DC 3.3");
  });

  it("50% duty at 0.5Hz keeps a normal trapezoid: 1s/2s -> PW 999.999ms", () => {
    // 1s/2s is 50% duty (ton far below period - 1us), so it stays a NORMAL
    // trapezoid with fixed 1us edges and PW = ton - 1us = 999.999ms. This is the
    // #59 form, unchanged by the #74 near-100% guard, and byte-identical to the
    // oracle.
    expect(pwmStimCard("1s", "2s")).toBe("PULSE(0 3.3 0 1us 1us 999.999ms 2s)");
  });

  it("near-100% duty (#74) mirrors the sub-edge triangle: span == period, no fall-edge truncation", () => {
    // For period - 1us < ton < period the normal span ton + 1us would overrun
    // the period and ngspice would truncate the fall edge at the wrap. The #74
    // guard shrinks the edges to period-ton and widens PW to 2*ton-period, so the
    // span is exactly the period. Byte-exact against the live oracle.
    expect(pwmStimCard("9.5us", "10us")).toBe("PULSE(0 3.3 0 500ns 500ns 9us 10us)");
    expect(pwmStimCard("9.9us", "10us")).toBe("PULSE(0 3.3 0 100ns 100ns 9.8us 10us)");
    expect(pwmStimCard("9.999us", "10us")).toBe("PULSE(0 3.3 0 1000ps 1000ps 9.998us 10us)");
  });

  it("the near-100% band boundary: 8.999us stays a normal trapezoid, 9us tips into the #74 triangle", () => {
    // The band is `ton > period - 1us`. In IEEE-754 doubles parseQuantity("10us")
    // is 9.999...e-6, so the normal span `9us + 1us` (1e-5) strictly exceeds the
    // parsed period and 9us/10us tips into the #74 branch (edges period-ton, PW
    // 2*ton-period); 8.999us/10us stays a normal fixed-1us-edge trapezoid. Both
    // emit duty 0.9 exactly. Byte-exact against the live oracle on BOTH sides --
    // this is the parity-critical boundary case (Python and JS share the same
    // double representation of "10us", so they classify 9us identically).
    expect(pwmStimCard("8.999us", "10us")).toBe("PULSE(0 3.3 0 1us 1us 7.999us 10us)");
    expect(pwmStimCard("9us", "10us")).toBe("PULSE(0 3.3 0 1000ns 1000ns 8us 10us)");
  });

  it("never emits a non-positive plateau across a sweep (ngspice would choke)", () => {
    const sweep: Array<[string, string]> = [
      ["100ns", "1us"], ["500ns", "1us"], ["1us", "1us"],
      ["250ns", "10us"], ["5us", "10us"], ["9us", "10us"], ["1s", "2s"],
    ];
    for (const [ton, period] of sweep) {
      const card = pwmStimCard(ton, period);
      if (card.startsWith("PULSE(")) {
        const fields = card.slice("PULSE(".length, card.lastIndexOf(")")).split(" ");
        expect(fields, `7 PULSE fields for ${ton}/${period}`).toHaveLength(7);
        const pw = fields[5]!;
        // PW is always non-negative: it is either `0s` or a positive quantity;
        // it must never carry a leading '-'.
        expect(pw.startsWith("-"), `${ton}/${period} -> ${card}`).toBe(false);
      }
    }
  });

  it("non-periodic write_gpio emits a DC rail, not a PULSE", () => {
    const xml = `
<system name="dc_gpio" ir_version="0.1">
  <nets>
    <net id="gnd" role="ground"/>
    <net id="sig" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="GND" net="gnd"/>
      <pin name="GPIO4" net="sig" function="GPIO_OUT"/>
    </component>
  </components>
  <firmware>
    <project id="fw" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <task id="t" target="fw">
      <write_gpio pin="GPIO4" value="high"/>
    </task>
  </firmware>
</system>`;
    const stim = netlistLines(xml).filter((l) => l.startsWith("V_STIM_"));
    expect(stim).toEqual(["V_STIM_U_MCU_GPIO4 sig 0 DC 3.3"]);
  });
});

// --------------------------------------------------------------------------- //
// .model card set                                                              //
// --------------------------------------------------------------------------- //

describe(".model card set", () => {
  const EXPECTED = [
    ".model NMOS NMOS(Vto=1.5 Kp=1)",
    ".model PMOS PMOS(Vto=-1.5 Kp=1)",
    ".model NPN NPN(Bf=100)",
    ".model PNP PNP(Bf=100)",
    ".model D D",
  ];

  it("BUILTIN_MODEL_CARDS matches the oracle set verbatim and in order", () => {
    expect([...BUILTIN_MODEL_CARDS]).toEqual(EXPECTED);
  });

  it("every netlist emits the header + all five model cards up front", () => {
    const xml = `
<system name="m" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="R1" type="resistor">
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
      <value>1k</value>
    </component>
  </components>
</system>`;
    const lines = netlistLines(xml);
    expect(lines.slice(0, 7)).toEqual([
      "* Generated by AIR",
      ".options filetype=ascii",
      ...EXPECTED,
    ]);
  });
});

// --------------------------------------------------------------------------- //
// Analysis-line construction                                                   //
// --------------------------------------------------------------------------- //

describe("analysis-line (.tran) construction", () => {
  const XML = `
<system name="a" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="R1" type="resistor">
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
      <value>1k</value>
    </component>
  </components>
  <tests>
    <test id="t1"><run duration="DURATION_PLACEHOLDER"/></test>
  </tests>
</system>`;

  function tranLine(duration: string | null): string {
    const xml = duration === null
      ? XML.replace(/<tests>[\s\S]*<\/tests>/, "")
      : XML.replace("DURATION_PLACEHOLDER", duration);
    const ir = parse(xml);
    const line = compileSpice(ir, firstTestOf(ir)).netlist
      .split("\n")
      .find((l) => l.startsWith(".tran"));
    expect(line).toBeDefined();
    return line!;
  }

  it("uses the test duration, run through spiceValue", () => {
    expect(tranLine("500ms")).toBe(".tran 1u 500ms");
    expect(tranLine("20ms")).toBe(".tran 1u 20ms");
    expect(tranLine("1s")).toBe(".tran 1u 1s");
  });

  it("`M` (mega) in a duration is rewritten to `Meg` (spiceValue)", () => {
    // spice_value("5M") -> "5Meg" (a trailing-M string means mega, not milli).
    expect(tranLine("5M")).toBe(".tran 1u 5Meg");
  });

  it("defaults to 100ms when there is no test (or no duration)", () => {
    expect(tranLine(null)).toBe(".tran 1u 100ms");
  });

  it("the control block wraps the analysis: .tran, .control, run, .endc, .end", () => {
    const ir = parse(XML.replace("DURATION_PLACEHOLDER", "10ms"));
    const lines = compileSpice(ir, firstTestOf(ir)).netlist.split("\n");
    // Trailing structure: ... .tran, .control, run, .endc, .end, "" (trailing NL).
    expect(lines.slice(-6)).toEqual([".tran 1u 10ms", ".control", "run", ".endc", ".end", ""]);
  });
});

// --------------------------------------------------------------------------- //
// CompileSpiceOptions: .ic, raw_stimulus, extra_probes (off the corpus path)   //
// --------------------------------------------------------------------------- //

describe("compileSpice options (.ic / rawStimulus / extraProbes)", () => {
  const XML = `
<system name="opts" ir_version="0.1">
  <nets>
    <net id="a" role="power"/>
    <net id="mid" role="analog_signal"/>
    <net id="gnd" role="ground"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <pin name="1" net="a"/><pin name="2" net="mid"/><value>1k</value>
    </component>
  </components>
  <tests>
    <test id="t1"><run duration="5ms"/><assert_voltage net="mid" min="0V" max="5V"/></test>
  </tests>
</system>`;

  it(".ic line normalizes ground and renders floats like CPython str(float)", () => {
    // Byte-exact vs oracle: `.ic V(a)=3.3 V(0)=0.0 V(b)=1.5e-06` (gnd -> 0,
    // 0.0 for zero, 1.5e-06 for the small float). Insertion order preserved.
    const ir = parse(XML);
    const ic = new Map<string, number>([
      ["a", 3.3],
      ["gnd", 0.0],
      ["b", 1.5e-6],
    ]);
    const line = compileSpice(ir, null, { initialConditions: ic }).netlist
      .split("\n")
      .find((l) => l.startsWith(".ic"));
    expect(line).toBe(".ic V(a)=3.3 V(0)=0.0 V(b)=1.5e-06");
  });

  it("rawStimulus REPLACES the MCU stimulus and lands after the test sources", () => {
    const ir = parse(XML);
    const lines = compileSpice(ir, null, { rawStimulus: ["V_RAW a 0 DC 42"] }).netlist.split("\n");
    expect(lines).toContain("V_RAW a 0 DC 42");
    // The raw line sits between the model cards and the component loop.
    const rawIdx = lines.indexOf("V_RAW a 0 DC 42");
    const rIdx = lines.indexOf("R_R1 a mid 1k");
    expect(rawIdx).toBeGreaterThan(0);
    expect(rawIdx).toBeLessThan(rIdx);
  });

  it("extraProbes unions with assertion nets and sorts; filename keeps the raw net, v() is normalized", () => {
    const ir = parse(XML);
    const firstTest = firstTestOf(ir);
    const probes = compileSpice(ir, firstTest, { extraProbes: ["a", "gnd", "mid"] }).netlist
      .split("\n")
      .filter((l) => l.startsWith("wrdata"));
    expect(probes).toEqual([
      "wrdata ../waveforms/t1_a.csv v(a)",
      "wrdata ../waveforms/t1_gnd.csv v(0)",
      "wrdata ../waveforms/t1_mid.csv v(mid)",
    ]);
  });

  it("an EMPTY rawStimulus array falls through to the MCU stimulus (Python `if raw_stimulus:` falsiness)", () => {
    // PARITY (rework r1 ??/falsy audit): Python's empty list is falsy, so the
    // oracle emits the MCU stimulus for raw_stimulus=[] exactly as for None
    // (verified live: both produce `V_STIM_U_MCU_GPIO0 sig 0 PULSE(0 3.3 0 1us
    // 1us 4.999ms 10ms)`; a non-empty list replaces it). A bare truthiness
    // check on a JS array would suppress the MCU lines.
    const ir = parse(`
<system name="raw_empty" ir_version="0.1">
  <nets>
    <net id="v33" role="power" nominal_voltage="3.3V"/>
    <net id="sig" role="digital_signal"/>
    <net id="gnd" role="ground"/>
  </nets>
  <components>
    <component id="V_33" type="voltage_source">
      <pin name="p" net="v33"/><pin name="n" net="gnd"/><value>3.3V</value>
    </component>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="v33"/><pin name="GND" net="gnd"/>
      <pin name="GPIO0" net="sig" function="GPIO_OUT"/>
    </component>
  </components>
  <firmware>
    <project id="fw" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <task id="t" target="fw">
      <period>10ms</period>
      <write_gpio pin="GPIO0" value="high"/>
      <delay duration="5ms"/>
      <write_gpio pin="GPIO0" value="low"/>
    </task>
  </firmware>
</system>`);
    const expectStim = ["V_STIM_U_MCU_GPIO0 sig 0 PULSE(0 3.3 0 1us 1us 4.999ms 10ms)"];
    const stimOf = (opts: Parameters<typeof compileSpice>[2]) =>
      compileSpice(ir, null, opts).netlist.split("\n").filter((l) => l.startsWith("V_STIM_"));
    expect(stimOf({ rawStimulus: [] })).toEqual(expectStim);
    expect(stimOf(null)).toEqual(expectStim);
    expect(stimOf({ rawStimulus: ["X_RAW a 0 SUB"] })).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// probes.json                                                                  //
// --------------------------------------------------------------------------- //

describe("probes descriptor", () => {
  it("is always the empty object with a trailing newline", () => {
    const ir = parse(`
<system name="p" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="R1" type="resistor">
      <pin name="p" net="a"/><pin name="n" net="gnd"/><value>1k</value>
    </component>
  </components>
</system>`);
    expect(compileSpice(ir, null).probes).toBe("{}\n");
  });
});

// --------------------------------------------------------------------------- //
// AC small-signal analysis (issue #62) -- byte-exact vs the Python oracle.    //
// --------------------------------------------------------------------------- //
//
// Expected strings are the LITERAL bytes the oracle emits for the ground-truth
// rc_lowpass_fc circuit (captured by running
// packages/core/src/air/spice.compile_spice on the same XML with real ngspice
// v46 and reading main.cir off disk). Assertions are byte-exact `toBe`, not
// tolerance -- byte parity is the criterion (#9 / #62).
describe("AC analysis emission (issue #62, byte-exact vs oracle)", () => {
  const AC_RC_XML = `<system name="gt_rc_lowpass_fc" ir_version="0.1">
  <metadata><title>rc_lowpass_fc</title></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vin" role="power" nominal_voltage="1V"/>
    <net id="vout" role="analog_signal"/>
  </nets>
  <components>
    <component id="V_IN" type="voltage_source">
      <value>1V</value>
      <property name="ac_magnitude" value="1V"/>
      <pin name="p" net="vin"/>
      <pin name="n" net="gnd"/>
    </component>
    <component id="R_F" type="resistor">
      <value>1.6k</value>
      <pin name="1" net="vin"/>
      <pin name="2" net="vout"/>
    </component>
    <component id="C_F" type="capacitor">
      <value>100nF</value>
      <pin name="1" net="vout"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <tests>
    <test id="lpf_fc">
      <analysis type="ac" sweep="dec" points="40" start="10Hz" end="1MegHz"/>
      <assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="p" default="true"><backend type="ngspice"/><run test="lpf_fc"/></profile>
  </simulation_profiles>
</system>`;

  it("emits the exact netlist bytes the Python oracle emits for the rc_lowpass_fc circuit", () => {
    const ir = parse(AC_RC_XML);
    const firstTest = firstTestOf(ir);
    const netlist = compileSpice(ir, firstTest).netlist;
    // These bytes were captured verbatim from `air.spice.compile_spice` on the
    // same XML (Python 3.14 / ngspice-46 environment). Any drift (spacing,
    // scientific-notation form, trailing newline) fails the parity contract.
    const expected = [
      "* Generated by AIR",
      ".options filetype=ascii",
      ".model NMOS NMOS(Vto=1.5 Kp=1)",
      ".model PMOS PMOS(Vto=-1.5 Kp=1)",
      ".model NPN NPN(Bf=100)",
      ".model PNP PNP(Bf=100)",
      ".model D D",
      "C_C_F vout 0 100nF",
      "R_R_F vin vout 1.6k",
      "V_V_IN vin 0 DC 1V AC 1V",
      ".ac dec 40 10 1e+06",
      ".control",
      "run",
      "wrdata ../waveforms/lpf_fc_vout.csv vdb(vout) vp(vout)",
      ".endc",
      ".end",
      "",
    ].join("\n");
    expect(netlist).toBe(expected);
  });

  it("uses .ac not .tran when a test carries <analysis type=\"ac\"...>", () => {
    const ir = parse(AC_RC_XML);
    const lines = compileSpice(ir, firstTestOf(ir)).netlist.split("\n");
    expect(lines.some((l) => l.startsWith(".ac dec 40"))).toBe(true);
    expect(lines.some((l) => l.startsWith(".tran"))).toBe(false);
  });

  it("tags voltage_source lines with `AC {ac_magnitude}` under AC (default 0 when the property is absent)", () => {
    // The oracle emits ``AC 0`` on any voltage_source without an ac_magnitude
    // property so it acts as a pure bias under the .ac solve.
    const xml = `<system name="ac_default" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="V1" type="voltage_source">
      <value>5V</value>
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
    </component>
    <component id="R1" type="resistor">
      <value>1k</value>
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
    </component>
  </components>
  <tests>
    <test id="t">
      <analysis type="ac" sweep="dec" points="10" start="1Hz" end="1kHz"/>
    </test>
  </tests>
  <simulation_profiles><profile id="p" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>`;
    const ir = parse(xml);
    const line = compileSpice(ir, firstTestOf(ir)).netlist.split("\n").find((l) => l.startsWith("V_V1"))!;
    expect(line).toBe("V_V1 a 0 DC 5V AC 0");
  });

  it("emits wrdata `vdb(net) vp(net)` per probe under AC, sorted by net name", () => {
    const xml = `<system name="ac_multi" ir_version="0.1">
  <nets>
    <net id="a" role="power"/>
    <net id="b" role="analog_signal"/>
    <net id="gnd" role="ground"/>
  </nets>
  <components>
    <component id="V1" type="voltage_source">
      <value>1V</value>
      <property name="ac_magnitude" value="1V"/>
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
    </component>
    <component id="R1" type="resistor"><value>1k</value><pin name="p" net="a"/><pin name="n" net="b"/></component>
    <component id="C1" type="capacitor"><value>1uF</value><pin name="p" net="b"/><pin name="n" net="gnd"/></component>
  </components>
  <tests>
    <test id="t">
      <analysis type="ac" sweep="dec" points="10" start="1Hz" end="1kHz"/>
      <assert_gain_db_at_freq net="b" freq="100Hz" min_db="-3" max_db="0"/>
      <assert_voltage net="a" min="0.9V" max="1.1V"/>
    </test>
  </tests>
  <simulation_profiles><profile id="p" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>`;
    const ir = parse(xml);
    const probes = compileSpice(ir, firstTestOf(ir)).netlist.split("\n").filter((l) => l.startsWith("wrdata"));
    // Both assert_gain_db_at_freq and assert_voltage contribute probe nets when
    // the analysis is AC; both are emitted with vdb()/vp(). Ordering is by net
    // name (pyStrCmp -> lex on code points).
    expect(probes).toEqual([
      "wrdata ../waveforms/t_a.csv vdb(a) vp(a)",
      "wrdata ../waveforms/t_b.csv vdb(b) vp(b)",
    ]);
  });

  it("falls back to the historical .tran path when no <analysis> child is present (backward compatible)", () => {
    // A test without <analysis> must emit exactly the pre-#62 netlist -- no
    // .ac card, no AC token on voltage sources, wrdata v(net) not vdb/vp. This
    // is the guardrail for the golden corpus: none of its designs carry
    // <analysis>, so their netlist bytes stay identical.
    const xml = `<system name="tran_still_works" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="V1" type="voltage_source">
      <value>5V</value>
      <property name="ac_magnitude" value="1V"/>
      <pin name="p" net="a"/><pin name="n" net="gnd"/>
    </component>
    <component id="R1" type="resistor"><value>1k</value><pin name="p" net="a"/><pin name="n" net="gnd"/></component>
  </components>
  <tests>
    <test id="t">
      <run duration="10ms"/>
      <assert_voltage net="a" min="4.9V" max="5.1V"/>
    </test>
  </tests>
  <simulation_profiles><profile id="p" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>`;
    const ir = parse(xml);
    const lines = compileSpice(ir, firstTestOf(ir)).netlist.split("\n");
    expect(lines).toContain(".tran 1u 10ms");
    expect(lines.some((l) => l.startsWith(".ac"))).toBe(false);
    // Voltage source has no AC token even though ac_magnitude property exists
    // (the property is inert in the .tran path).
    const v = lines.find((l) => l.startsWith("V_V1"))!;
    expect(v).toBe("V_V1 a 0 DC 5V");
    // wrdata uses v(net) not vdb/vp.
    const wr = lines.find((l) => l.startsWith("wrdata"))!;
    expect(wr).toBe("wrdata ../waveforms/t_a.csv v(a)");
  });

  it("frequency start/end in the .ac card use ngspice-parseable scientific form byte-for-byte with Python %g", () => {
    // The oracle renders via CPython %g. Byte-parity requires the same:
    //   10Hz -> "10", 1MegHz -> "1e+06", 1kHz -> "1000".
    function acLine(startExpr: string, endExpr: string): string {
      const xml = `<system name="a" ir_version="0.1">
  <nets><net id="a" role="power"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="R1" type="resistor"><value>1k</value><pin name="p" net="a"/><pin name="n" net="gnd"/></component>
  </components>
  <tests>
    <test id="t"><analysis type="ac" sweep="dec" points="10" start="${startExpr}" end="${endExpr}"/></test>
  </tests>
  <simulation_profiles><profile id="p" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>`;
      const ir = parse(xml);
      return compileSpice(ir, firstTestOf(ir)).netlist.split("\n").find((l) => l.startsWith(".ac"))!;
    }
    expect(acLine("10Hz", "1MegHz")).toBe(".ac dec 10 10 1e+06");
    expect(acLine("1Hz", "1kHz")).toBe(".ac dec 10 1 1000");
    expect(acLine("0.1Hz", "10kHz")).toBe(".ac dec 10 0.1 10000");
  });
});
