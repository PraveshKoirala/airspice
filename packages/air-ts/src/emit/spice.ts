/**
 * Port of `packages/core/src/air/spice.py` (the SPICE netlist emitter).
 *
 * Produces the two deterministic, byte-exact artifacts the golden corpus commits
 * for every VALID design:
 *   - `main.cir`   -- the ngspice netlist (`<design>/netlist.cir` in the corpus)
 *   - `probes.json` -- the SPICE probes descriptor (`<design>/report/probes.json`)
 *
 * The WASM simulator (#13) consumes exactly these netlists, so byte parity here
 * is the whole point: M2 inherits the tested simulation semantic for free. A
 * harmless-looking difference is this emitter being wrong (issue #9 guardrail).
 *
 * PARITY DISCIPLINE (the non-obvious bits copied verbatim from spice.py):
 *   - Ground normalization: a pin net named `gnd` OR `0` (case-insensitive)
 *     renders as the SPICE ground node `0`. `_spiceNet`.
 *   - Node names are otherwise emitted UNMANGLED (spice.py does no escaping).
 *   - Component-card ordering is `sorted(components.values(), key=c.id)` --
 *     a lexicographic sort on the id STRING, NOT document order.
 *   - Pin POSITIONS come from document-order Map iteration (`pins[0]`, `pins[1]`
 *     ...), NOT the alphabetically-sorted model.json. model.json sorts keys; the
 *     live pins Map preserves insertion order, and passives frequently declare
 *     their pins p-before-n, so `pins[0]` is the p pin (issue #8 rework; see
 *     model.ts header). This is why L_LOAD emits `v_bat load_low`, not the
 *     reverse.
 *   - Test voltage sources are emitted from `sorted(test.setup.items())` (sort by
 *     key) BEFORE the component loop, skipping nets already driven by a
 *     `voltage_source` component (the component source wins; a parallel test
 *     source would abort ngspice).
 *   - MCU firmware stimulus (PULSE / DC) is emitted between the test sources and
 *     the component loop, in `firmware_tasks` document order.
 *   - The PWM PULSE math is the post-#59 duty-compensated form, including the
 *     near-100%-duty triangle corner (#74; see `pwmPulse`). Both are ported from
 *     the oracle for byte parity.
 *   - Float rendering goes through `formatQuantity` / `spiceValue` from #7, which
 *     reproduce CPython's `"%.6g"` and the `M`->`Meg` rewrite byte-for-byte.
 *
 * Zero DOM / fs dependency: this module returns strings; only test code touches
 * the filesystem (epic #6: browser/Worker-safe).
 */

import type { Component, FirmwareOperation, SystemIR, Test } from "../model.js";
import { formatQuantity, parseQuantity, spiceValue } from "../units.js";
import { formatNumber } from "../format.js";
import { hasErrors, validateAll } from "../validate/index.js";
import { parseXml } from "../xml.js";
import { parseTree } from "../parser.js";

/** Nets that normalize to the SPICE ground node `0` (case-insensitive). */
const GROUND_NAMES = new Set(["gnd", "0"]);

/**
 * Fixed rise/fall time (1 us) for the firmware -> SPICE PWM `PULSE` stimulus, in
 * seconds. Mirrors spice.py `PWM_EDGE_S`: kept small and constant so a digital
 * GPIO edge is effectively instantaneous relative to any analog time constant.
 */
const PWM_EDGE_S = 1e-6;

/**
 * The generic device models the compiler emits a `.model` card for in EVERY
 * netlist. A component `spice_model` is only simulable if it names one of these
 * (validation's UNDEFINED_SPICE_MODEL gate, #55, uses the same set). Mirror of
 * spice.py `BUILTIN_SPICE_MODELS`.
 */
export const BUILTIN_SPICE_MODELS: ReadonlySet<string> = new Set([
  "NMOS",
  "PMOS",
  "NPN",
  "PNP",
  "D",
]);

/**
 * No `.subckt` definitions are ever emitted, so any `spice_subckt` reference
 * (X_ line) is unbacked. Kept as an explicit empty set for parity with spice.py.
 */
export const BUILTIN_SPICE_SUBCKTS: ReadonlySet<string> = new Set<string>();

/** The `.model` cards emitted verbatim into every netlist (spice.py order). */
export const BUILTIN_MODEL_CARDS: readonly string[] = [
  ".model NMOS NMOS(Vto=1.5 Kp=1)",
  ".model PMOS PMOS(Vto=-1.5 Kp=1)",
  ".model NPN NPN(Bf=100)",
  ".model PNP PNP(Bf=100)",
  ".model D D",
];

/** The two artifacts a successful SPICE compile produces. */
export interface SpiceArtifacts {
  /** `main.cir` netlist text (LF-terminated, trailing newline included). */
  netlist: string;
  /** `probes.json` descriptor text -- always `"{}\n"` in the current oracle. */
  probes: string;
}

/** Optional extra inputs to `compileSpice`, matching spice.py's keyword args. */
export interface CompileSpiceOptions {
  /** `.ic V(net)=val` lines, in insertion order (spice.py `initial_conditions`). */
  initialConditions?: Map<string, number> | null;
  /** Verbatim stimulus lines that REPLACE the MCU stimulus (spice.py `raw_stimulus`). */
  rawStimulus?: string[] | null;
  /** Extra probe nets unioned with the test's assertion nets (spice.py `extra_probes`). */
  extraProbes?: string[] | null;
}

/**
 * Emit the SPICE netlist + probes descriptor for `ir`, mirroring spice.py
 * `compile_spice`. This is the RAW emitter: like the oracle function, it does
 * NOT gate on validation -- it emits for whatever IR it is handed. The exporter
 * gates externally (`if valid: compile_spice(...)`); `compileDesign` below
 * reproduces that gate for the public path.
 *
 * The Python function also emits `UNSUPPORTED_SPICE_COMPONENT` warnings and a
 * `success` flag, but neither affects the two byte-compared artifacts, so this
 * pure emitter returns only the netlist + probes strings. `mcu`/`generic_load`
 * components that produce no line are silently skipped, exactly as in spice.py.
 */
export function compileSpice(
  ir: SystemIR,
  test?: Test | null,
  options?: CompileSpiceOptions | null,
): SpiceArtifacts {
  const initialConditions = options?.initialConditions ?? null;
  const rawStimulus = options?.rawStimulus ?? null;
  const extraProbes = options?.extraProbes ?? null;

  const lines: string[] = ["* Generated by AIR", ".options filetype=ascii", ...BUILTIN_MODEL_CARDS];

  if (initialConditions && initialConditions.size > 0) {
    // spice.py: `f"V({net})={val}"` where `val` is a float -> Python `str(float)`,
    // which `formatNumber` reproduces (CPython repr). This branch is not on the
    // corpus/differential path (the exporter never passes initial_conditions),
    // but the port stays faithful in case a caller uses it.
    const parts: string[] = [];
    for (const [net, val] of initialConditions) {
      parts.push(`V(${spiceNet(net)})=${formatNumber(val)}`);
    }
    lines.push(".ic " + parts.join(" "));
  }

  // Nets already driven by a voltage_source component: a test set_voltage on the
  // same net would emit a second parallel source and make ngspice abort (vsource
  // loop). The component source wins; the redundant test source is skipped.
  const componentSourceNets = new Set<string>();
  for (const component of ir.components.values()) {
    if (component.type === "voltage_source" && component.value && component.pins.size >= 2) {
      const firstPin = firstMapValue(component.pins);
      if (firstPin) componentSourceNets.add(firstPin.net);
    }
  }

  const voltageSources = testVoltageSources(test ?? null);
  for (const [sourceName, [net, value]] of voltageSources) {
    if (componentSourceNets.has(net)) continue;
    lines.push(`${sourceName} ${spiceNet(net)} 0 DC ${spiceValue(value)}`);
  }

  // PARITY: spice.py's `if raw_stimulus:` is Python truthiness -- an EMPTY
  // list is falsy, so `raw_stimulus=[]` falls through to the MCU stimulus.
  // A bare `if (rawStimulus)` would treat [] as truthy and silently suppress
  // the MCU lines (found in the rework round 1 ??/falsy audit).
  if (rawStimulus && rawStimulus.length > 0) {
    lines.push(...rawStimulus);
  } else {
    lines.push(...mcuStimulusLines(ir));
  }

  for (const component of sortedComponents(ir)) {
    const emitted = componentLine(component, test ?? null);
    if (emitted) {
      lines.push(emitted);
    } else if (component.type === "mcu" || component.type === "generic_load") {
      continue;
    } else if (component.type === "ldo") {
      lines.push(ldoLine(component));
    }
    // else: UNSUPPORTED_SPICE_COMPONENT warning (diagnostic only, no netlist line).
  }

  const duration = test && test.duration ? test.duration : "100ms";
  lines.push(`.tran 1u ${spiceValue(duration)}`, ".control", "run");

  if (test) {
    const assertionNets = new Set<string>();
    for (const a of test.assertions) {
      if (a["op"] === "assert_voltage" && a["net"]) {
        assertionNets.add(a["net"]);
      }
    }
    for (const net of extraProbes ?? []) assertionNets.add(net);
    const probeNets = [...assertionNets].sort(pyStrCmp);
    for (const net of probeNets) {
      lines.push(`wrdata ../waveforms/${test.id}_${net}.csv v(${spiceNet(net)})`);
    }
  }

  lines.push(".endc", ".end", "");

  return { netlist: lines.join("\n"), probes: "{}\n" };
}

/**
 * Build the SPICE card for a single component, mirroring spice.py
 * `_component_line`. Returns null when the type/pin shape does not map to a
 * device line (the caller then skips it or, for `ldo`, calls `ldoLine`).
 *
 * The device-line templates and their pin-role lookups (`C`/`B`/`E`, `G`/`D`/`S`,
 * `a`/`c`) are copied verbatim, including the MOSFET's doubled source node
 * (`... {s} {s} {model}`, bulk tied to source) and the default model fallbacks
 * (`NPN` / `NMOS` / `D`).
 */
function componentLine(component: Component, test: Test | null): string | null {
  const pins = [...component.pins.values()];

  if (component.type === "resistor" && component.value && pins.length >= 2) {
    return `R_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} ${spiceValue(component.value)}`;
  }
  if (component.type === "capacitor" && component.value && pins.length >= 2) {
    return `C_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} ${spiceValue(component.value)}`;
  }
  if (component.type === "voltage_source" && component.value && pins.length >= 2) {
    return `V_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} DC ${spiceValue(component.value)}`;
  }
  if (component.type === "current_source" && component.value && pins.length >= 2) {
    return `I_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} DC ${spiceValue(component.value)}`;
  }
  if (component.type === "bjt" && pins.length >= 3) {
    const c = component.pins.get("C");
    const b = component.pins.get("B");
    const e = component.pins.get("E");
    const model = component.spice_model || "NPN";
    if (c && b && e) {
      return `Q_${component.id} ${spiceNet(c.net)} ${spiceNet(b.net)} ${spiceNet(e.net)} ${model}`;
    }
  }
  if (component.type === "mosfet" && pins.length >= 3) {
    const g = component.pins.get("G");
    const d = component.pins.get("D");
    const s = component.pins.get("S");
    const model = component.spice_model || "NMOS";
    if (g && d && s) {
      return `M_${component.id} ${spiceNet(d.net)} ${spiceNet(g.net)} ${spiceNet(s.net)} ${spiceNet(s.net)} ${model}`;
    }
  }
  if (component.type === "diode" && pins.length >= 2) {
    const a = component.pins.get("a");
    const c = component.pins.get("c");
    const model = component.spice_model || "D";
    if (a && c) {
      return `D_${component.id} ${spiceNet(a.net)} ${spiceNet(c.net)} ${model}`;
    }
  }
  if (component.spice_subckt) {
    // Generic subcircuit emission.
    const pinNets = pins.map((p) => spiceNet(p.net)).join(" ");
    return `X_${component.id} ${pinNets} ${component.spice_subckt}`;
  }
  if (component.type === "generic_load" && pins.length >= 2) {
    const step = testLoadStep(test, component.id);
    if (step) {
      const [start, stop, at, rise] = step;
      return (
        `I_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} ` +
        `PULSE(${spiceValue(start)} ${spiceValue(stop)} ${spiceValue(at)} ${spiceValue(rise)} ${spiceValue(rise)} 1s 2s)`
      );
    }
    // PARITY: spice.py chains these with `or` -- `_test_current(...) or
    // properties.get("current") or value` -- and Python `or` falls through
    // EVERY falsy value, including the EMPTY STRING (a <set_current> with no
    // value attribute stores "" in setup; an empty current property is "").
    // `??` stops at "" and silently drops the device line (rework round 1,
    // divergence 1). `||` reproduces the Python or-chain for strings exactly.
    const current =
      testCurrent(test, component.id) ||
      component.properties.get("current") ||
      component.value;
    if (current) {
      return `I_${component.id} ${spiceNet(pins[0]!.net)} ${spiceNet(pins[1]!.net)} DC ${spiceValue(current)}`;
    }
  }
  return null;
}

/**
 * MCU firmware stimulus lines, mirroring spice.py `_mcu_stimulus_lines`. Walks
 * `firmware_tasks` in document order; for each `write_gpio` op it emits either a
 * PWM PULSE (periodic + high) or a DC rail (non-periodic). The ON-time `ton` is
 * the first `delay` op after `task.operations.index(op)` -- the FIRST
 * content-equal occurrence of the op, not necessarily the current position
 * (see the PARITY note in the body) -- defaulting to `1ms` when there is no
 * following delay (spice.py's `ton = "1ms"` default).
 */
function mcuStimulusLines(ir: SystemIR): string[] {
  const lines: string[] = [];
  for (const task of ir.firmware_tasks.values()) {
    const project = ir.firmware_projects.get(task.target);
    if (!project) continue;
    const mcu = ir.components.get(project.target);
    if (!mcu) continue;

    const operations = task.operations;
    for (let opIdx = 0; opIdx < operations.length; opIdx++) {
      const op = operations[opIdx] as FirmwareOperation;
      if (op["op"] !== "write_gpio") continue;
      const pinName = op["pin"];
      const value = op["value"];
      if (pinName === undefined) continue;
      const pin = mcu.pins.get(pinName);
      if (!pin) continue;

      if (task.period && value === "high") {
        // Periodic high-low -> a SPICE PULSE. The firmware ON-time `ton` (the
        // `delay` following `write_gpio high`) is the INTENDED high-time;
        // `pwmPulse(ton, period)` compensates the ramp area (#59).
        //
        // PARITY: spice.py computes `op_idx = task.operations.index(op)`, and
        // Python `list.index` compares by CONTENT equality (dict ==), NOT
        // identity/position. When two operations are content-identical (the
        // same write_gpio pin/value twice with different following delays),
        // `.index` returns the FIRST occurrence for BOTH, so both stimulus
        // lines pick the first op's delay as ton. Using the true loop index
        // here would be "more correct" and is exactly what parity forbids
        // (rework round 1, divergence 2). Replicate `.index` verbatim.
        const searchIdx = firstContentEqualIndex(operations, op);
        let ton = "1ms";
        for (let j = searchIdx + 1; j < operations.length; j++) {
          const next = operations[j] as FirmwareOperation;
          if (next["op"] === "delay") {
            // spice.py: `next_op.get("duration", "1ms")` -- dict.get with a
            // default substitutes ONLY on a MISSING key (an empty duration=""
            // stays ""), which is exactly `??` (NOT `||`).
            ton = next["duration"] ?? "1ms";
            break;
          }
        }
        const stim = pwmPulse(ton, task.period);
        lines.push(`V_STIM_${mcu.id}_${pinName} ${spiceNet(pin.net)} 0 ${stim}`);
      } else if (!task.period) {
        const v = value === "high" ? "3.3" : "0";
        lines.push(`V_STIM_${mcu.id}_${pinName} ${spiceNet(pin.net)} 0 DC ${v}`);
      }
    }
  }
  return lines;
}

/**
 * Build the SPICE `PULSE` card for a firmware PWM with the intended duty,
 * mirroring spice.py `_pwm_pulse` (post-#59). `ton` is the firmware ON-time and
 * intended high-time; the compensated plateau `PW = ton - (TR+TF)/2` makes the
 * emitted trapezoid's true one-period average equal `D * amplitude` exactly,
 * independent of frequency.
 *
 * Degenerate cases (guarded so ngspice never sees a non-positive/zero-period
 * plateau and the emitted trapezoid never overruns the period), verbatim from
 * the oracle:
 *   - `ton <= 0` (0% duty)                 -> `DC 0`  (flat rail, no pulse)
 *   - `ton >= period` (>=100% duty)        -> `DC {amplitude}`
 *   - `0 < ton <= PWM_EDGE_S`              -> shrink edges to `ton`, `PW = 0`
 *                                             (sub-edge triangle)
 *   - `period - PWM_EDGE_S < ton < period` -> shrink edges to `period-ton` and
 *                                             widen `PW = 2*ton-period` so the
 *                                             span is exactly the period
 *                                             (near-100% triangle, #74)
 *
 * The near-100% branch (#74) mirrors the sub-edge triangle at the top end: the
 * normal span `ton + PWM_EDGE_S` would overrun the period and ngspice would
 * truncate the fall edge at the wrap, so we set `TR = TF = period - ton` and
 * `PW = 2*ton - period`; the high-area `PW + (TR+TF)/2 = ton` still gives duty
 * `ton/period`, and the span is exactly the period.
 */
function pwmPulse(ton: string, period: string, amplitude = "3.3"): string {
  const tonS = parseQuantity(ton, "s");
  const periodS = parseQuantity(period, "s");

  // 0% / 100% duty -> a constant rail; a PULSE would be a needless (and, for
  // PW<=0, invalid) card.
  if (tonS <= 0) {
    return "DC 0";
  }
  if (periodS > 0 && tonS >= periodS) {
    return `DC ${amplitude}`;
  }

  let edgeS = PWM_EDGE_S;
  let pwS: number;
  if (tonS <= edgeS) {
    // Sub-edge on-time: collapse the plateau and shrink the edges so the
    // triangle area (TR+TF)/2 == ton (duty preserved) and PW stays > 0-safe.
    edgeS = tonS;
    pwS = 0.0;
  } else if (tonS > periodS - edgeS) {
    // Near-100% duty (#74): the normal span ton + PWM_EDGE_S would overrun the
    // period and ngspice would truncate the fall edge at the wrap. Mirror the
    // sub-edge triangle at the top end -- shrink the edges to period-ton and
    // widen the plateau to 2*ton-period so the span is exactly the period and
    // the high-area stays ton (duty preserved).
    edgeS = periodS - tonS;
    pwS = 2.0 * tonS - periodS;
  } else {
    pwS = tonS - edgeS;
  }

  const tr = formatQuantity(edgeS, "s");
  const pw = formatQuantity(pwS, "s");
  const per = spiceValue(period);
  return `PULSE(0 ${amplitude} 0 ${tr} ${tr} ${pw} ${per})`;
}

/**
 * Emit the LDO behavioural model, mirroring spice.py `_ldo_line`: an optional
 * quiescent-current draw plus a `VALUE = { min(Vtarget, V(in) - Vdropout) }`
 * behavioural source. Returns a multi-line string (joined with "\n", matching
 * the oracle's `"\n".join(lines)` which becomes one entry in the netlist list).
 */
function ldoLine(component: Component): string {
  const inNet = component.pins.get("in");
  const outNet = component.pins.get("out");
  const gndNet = component.pins.get("gnd");
  const vout = component.properties.get("vout") ?? "3.3V";
  const vDropout = component.properties.get("v_dropout") ?? "0.2V";
  const iq = component.properties.get("iq") ?? "0";

  if (!inNet || !outNet || !gndNet) {
    return `* LDO ${component.id} skipped: missing in/out/gnd`;
  }

  const lines: string[] = [];
  // Quiescent current.
  if (spiceValue(iq) !== "0") {
    lines.push(`I_${component.id}_iq ${spiceNet(inNet.net)} ${spiceNet(gndNet.net)} DC ${spiceValue(iq)}`);
  }

  // Voltage source with dropout: Vout = min(Vtarget, Vin - Vdropout).
  const expr = `min(${spiceValue(vout)}, V(${spiceNet(inNet.net)}) - ${spiceValue(vDropout)})`;
  lines.push(`E_${component.id} ${spiceNet(outNet.net)} ${spiceNet(gndNet.net)} VALUE = { ${expr} }`);

  return lines.join("\n");
}

/**
 * Test-provided voltage sources, mirroring spice.py `_test_voltage_sources`:
 * `{ f"V_{net.upper()}": (net, value) }` for every setup entry whose key is a
 * plain net (not a `current:` or `load_step:` encoded key), iterated in
 * `sorted(test.setup.items())` key order.
 */
function testVoltageSources(test: Test | null): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>();
  if (!test) return out;
  const entries = [...test.setup.entries()].sort((a, b) => pyStrCmp(a[0], b[0]));
  for (const [net, value] of entries) {
    if (net.startsWith("current:") || net.startsWith("load_step:")) continue;
    out.set(`V_${net.toUpperCase()}`, [net, value]);
  }
  return out;
}

/** Mirror of spice.py `_test_current`: the `current:<id>` setup value or null. */
function testCurrent(test: Test | null, componentId: string): string | null {
  if (!test) return null;
  return test.setup.get(`current:${componentId}`) ?? null;
}

/**
 * Mirror of spice.py `_test_load_step`: decode the `load_step:<id>` setup value
 * (`from,to,at,rise`) into a 4-tuple, or null when absent/malformed. The guard
 * (`len(parts) != 4 or not parts[0] or not parts[1]`) is reproduced exactly.
 */
function testLoadStep(
  test: Test | null,
  componentId: string,
): [string, string, string, string] | null {
  if (!test) return null;
  const encoded = test.setup.get(`load_step:${componentId}`);
  if (!encoded) return null;
  const parts = encoded.split(",");
  if (parts.length !== 4 || !parts[0] || !parts[1]) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

/** Mirror of spice.py `_spice_net`: `gnd`/`0` (any case) -> `0`, else verbatim. */
function spiceNet(net: string): string {
  return GROUND_NAMES.has(net.toLowerCase()) ? "0" : net;
}

/**
 * Components in `sorted(ir.components.values(), key=lambda c: c.id)` order.
 * Python's default string sort is by Unicode code point; `pyStrCmp` reproduces
 * it. This is a lexicographic sort on the id string -- NOT document order.
 */
function sortedComponents(ir: SystemIR): Component[] {
  return [...ir.components.values()].sort((a, b) => pyStrCmp(a.id, b.id));
}

/** First value of a Map in insertion (document) order, or undefined if empty. */
function firstMapValue<K, V>(map: Map<K, V>): V | undefined {
  for (const v of map.values()) return v;
  return undefined;
}

/**
 * Mirror of Python `list.index(op)` over firmware operations: the index of the
 * FIRST element content-equal to `op`. Python compares dicts with `==` -- same
 * key set and same values, insertion order ignored -- so two operations built
 * from identical XML elements are equal even though they are distinct objects.
 * `op` is always an element of `operations`, so a match always exists; the
 * fallback return is defensive only.
 */
function firstContentEqualIndex(
  operations: readonly FirmwareOperation[],
  op: FirmwareOperation,
): number {
  for (let i = 0; i < operations.length; i++) {
    if (operationsEqual(operations[i] as FirmwareOperation, op)) return i;
  }
  return operations.indexOf(op);
}

/** Python dict `==` for two string-record operations (order-insensitive). */
function operationsEqual(a: FirmwareOperation, b: FirmwareOperation): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Compare two strings the way Python's default `sorted`/`<` does: lexicographic
 * by UTF-16 code unit, which agrees with Python's code-point ordering for the
 * Basic Multilingual Plane (all ASCII ids/nets in the corpus). Returns -1/0/1.
 *
 * JS's default Array.sort coerces to string and ALSO compares by UTF-16 code
 * unit, but only via the default comparator; passing this explicit comparator
 * makes the intent (and the parity guarantee) legible.
 */
function pyStrCmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Public, validation-gated compile entry mirroring the exporter's
 * `if valid: compile_spice(ir, tmp, first_test)` (scripts/export_golden.py) and
 * `service.compile_design`: a design with ANY error-severity diagnostic is
 * REFUSED -- no netlist, no probes -- exactly like the corpus, where a failing
 * design's absent `netlist.cir` is itself the expected output.
 *
 * `first_test` is `next(iter(ir.tests.values()), None)` -- the first test in
 * document order, or null when the design declares none.
 *
 * Returns the two artifact strings on success, or `null` on refusal.
 */
export function compileDesign(xmlText: string): SpiceArtifacts | null {
  const root = parseXml(xmlText);
  const ir = parseTree(root);
  const diagnostics = validateAll(root, ir);
  if (hasErrors(diagnostics)) {
    return null;
  }
  const firstTest = firstMapValue(ir.tests) ?? null;
  return compileSpice(ir, firstTest);
}
