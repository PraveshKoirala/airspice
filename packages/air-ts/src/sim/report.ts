/**
 * Browser simulation report pipeline (issue #14).
 *
 * PURE functions (no Worker, no DOM, no fs): given the WASM engine's WaveTables
 * (#13, sim-wasm), the parsed design IR (#7 model), and the test's assertion
 * specs, produce a report object schema-IDENTICAL to what the Python oracle's
 * `simulator.py` (`simulate_analog`) writes into the golden corpus
 * (`tests/golden_corpus/<design>/report/reports/<test>.json`).
 *
 * Why this exists (epic #12 binding decision 4; AGENTS.md rule): the agent tools
 * (#18) and the repair loop (#19) key off this report's EXACT shape — the
 * `measurement_stats` keys, the `diagnostics[].code` strings, the `convergence`
 * section. Schema drift here silently breaks the whole agent story later. So the
 * structure (JSON keys + ordering after `sort_keys=True`, the convergence
 * section, the diagnostic codes) is byte-exact; only the numeric field VALUES
 * differ (eecircuit ngspice 45.2 vs native 42), and only within the parity
 * tolerance (#15's domain).
 *
 * PARITY DISCIPLINE (the non-obvious bits copied verbatim from simulator.py):
 *   - `measurement_stats` min/max TIE-BREAKING: Python's `min(samples,
 *     key=value)` / `max(samples, key=value)` return the FIRST sample achieving
 *     the extremum (a strict `<` / `>` scan keeps the first). `time_of_min` /
 *     `time_of_max` are that first extremum's time. `final` is the LAST sample.
 *     A flat waveform therefore has min=max=final and time_of_min=time_of_max=
 *     the first sample's time (0). See `statsForSamples`.
 *   - Number rendering goes through `formatQuantity` (`%.6g`-based) for
 *     final/min/max and `formatG(t, 9)` (`%.9g`) + "s" for the time fields, both
 *     of which reproduce CPython byte-for-byte (#7 format.ts).
 *   - The DC solver (`measureDc` / `solveResistiveDividers`) is a verbatim port
 *     of `_measure_dc` / `_solve_resistive_dividers`: the browser has NO backend,
 *     so the report's non-probed-net measurements come from the SAME analytic DC
 *     pass the oracle runs, and only the PROBED nets are overwritten by the
 *     transient's waveform stats — exactly as `simulate_analog` does
 *     (`stats.update(waveform_stats)`).
 *   - Assertion evaluation (`evaluateAssertions`) is a verbatim port of
 *     `_evaluate_assertions`: same subjects (`i(<component>)` for currents), same
 *     `ASSERT_NO_MEASUREMENT` / `ASSERT_FAILED` codes, same observed/expected
 *     payloads. Repair-context keys on these codes.
 *
 * THE CONVERGENCE HONESTY (issue #45 / #14 scope): the #45 convergence-aid ladder
 * (gmin/source-stepping retry) lives in `simulator.py`, NATIVE-side. The browser
 * eecircuit engine runs the netlist AS-WRITTEN only — no ladder. For every corpus
 * design that converges on rung 1 (`aids_required:false, rung:1`), the browser's
 * honest `convergence` section is byte-identical to the oracle's. A design that
 * would need rung>=2 the browser cannot rescue; it reports the honest not-
 * converged rung-1 attempt (browser-side ladder via eecircuit `.options`
 * injection is future work). We do NOT fabricate a ladder the browser never ran.
 */

import type { Component, SystemIR, Test } from "../model.js";
import { formatQuantity, parseQuantity } from "../units.js";
import { formatG, formatNumber } from "../format.js";

/** A single simulation sample: `[time_s, value]`. */
export type Sample = [number, number];

/** Per-signal statistics, mirroring simulator.py `SignalStats`. */
export interface SignalStats {
  final: number;
  min: number;
  max: number;
  timeOfMin: number;
  timeOfMax: number;
  unit: string;
}

/**
 * The minimal WaveTable shape this module consumes. Structurally compatible with
 * sim-wasm's `WaveTable` (name + `Float64Array` values); `unit` is unused here
 * (the report derives unit from the signal name, matching the oracle). Kept as a
 * local interface so this pure module has ZERO dependency on packages/sim-wasm.
 */
export interface WaveTableLike {
  name: string;
  values: Float64Array;
}

/**
 * A diagnostic, mirroring diagnostics.py `Diagnostic.to_dict()`. Field order is
 * irrelevant to the corpus (the exporter re-serializes with `sort_keys=True`),
 * but the KEY SET and the code strings are load-bearing.
 */
export interface ReportDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  domain: string;
  code: string;
  message: string;
  related_elements: string[];
  observed: Record<string, unknown>;
  expected: Record<string, unknown>;
  suggested_actions: string[];
}

/** A serialized measurement_stats entry: the `%.6g`/`%.9g` string forms. */
export interface SerializedStats {
  final: string;
  min: string;
  max: string;
  time_of_min: string;
  time_of_max: string;
}

/** One convergence attempt, mirroring the oracle's `convergence.attempts[]`. */
export interface ConvergenceAttempt {
  rung: number;
  name: string;
  options: string[];
  converged: boolean;
  /** Present (and true) only when ngspice was never run (missing engine). */
  ngspice_missing?: boolean;
}

/** The report's `convergence` section, mirroring `_convergence_section`. */
export interface ConvergenceSection {
  attempts: ConvergenceAttempt[];
  converged: boolean;
  rung: number | null;
  aids_required: boolean;
  terminal: boolean;
  note: string | null;
}

/**
 * A single test's report, mirroring the dict `simulate_analog` builds. Insertion
 * order here is irrelevant to corpus parity (the exporter dumps with
 * `sort_keys=True`); `serializeReportJson` reproduces that sorted form.
 */
export interface SimulationReport {
  profile: string;
  test: string;
  status: "passed" | "failed";
  backend: string;
  convergence: ConvergenceSection;
  measurements: Record<string, string>;
  measurement_stats: Record<string, SerializedStats>;
  diagnostics: ReportDiagnostic[];
  artifacts: string[];
}

/** The top-level result object `simulate_analog` returns (one per profile). */
export interface SimulationResult {
  success: boolean;
  profile: string;
  status: "passed" | "failed";
  reports: SimulationReport[];
}

/**
 * Inputs to build ONE test's report. `waveTables` are the engine's per-probe
 * tables for THIS test (plus the sweep vector); the "time" table names the time
 * axis, and each `v(<net>)` / `i(<dev>)` table names a probed signal.
 */
export interface ReportInputs {
  ir: SystemIR;
  test: Test;
  profileId: string;
  /** WaveTables produced by the browser engine for this run. */
  waveTables: readonly WaveTableLike[];
  /**
   * Whether the WASM engine was AVAILABLE and ATTEMPTED this run (true) vs. was
   * unreachable / never produced a result (false). This is the browser analogue
   * of `simulate_analog`'s `ngspice_run.attempted`, and it splits the two very
   * different not-converged cases in the honest convergence section:
   *   - `engineAttempted: false` -> engine unavailable: `ngspice_missing`
   *     rung-1 attempt + `builtin_dc_fallback` (the DC-fallback path owns it).
   *   - `engineAttempted: true` with NO probe data -> the engine RAN as-written
   *     and did NOT converge (e.g. eecircuit's singular-matrix on a design that
   *     native ngspice solves): HONEST `terminal: true` — disclosed, not papered
   *     over as a missing engine.
   * Defaults to true when omitted (the common "engine ran" path).
   */
  engineAttempted?: boolean;
}

// --------------------------------------------------------------------------- //
// DC solver — verbatim port of simulator.py `_measure_dc`.
// --------------------------------------------------------------------------- //

/**
 * Analytic DC measurement, mirroring `_measure_dc`. The browser has no backend,
 * so every NON-probed net's report value comes from this same pass the oracle
 * runs. The order of the four phases (known setup voltages -> voltage-source
 * propagation -> LDO outputs -> resistive-divider fixpoint -> load currents) and
 * the fixpoint's 1e-9 change threshold are copied exactly.
 */
export function measureDc(ir: SystemIR, test: Test): Map<string, number> {
  const measurements = new Map<string, number>();

  const knownVoltages = new Map<string, number>();
  for (const [net, value] of test.setup) {
    if (net.startsWith("current:") || net.startsWith("load_step:")) continue;
    knownVoltages.set(net, parseQuantity(value, "V"));
  }

  for (const net of ir.nets.values()) {
    if (knownVoltages.has(net.id)) {
      measurements.set(net.id, knownVoltages.get(net.id) as number);
    } else if (net.role === "ground") {
      measurements.set(net.id, 0.0);
    }
  }

  for (const component of ir.components.values()) {
    if (
      component.type === "voltage_source" &&
      component.value &&
      component.pins.size >= 2
    ) {
      const pins = [...component.pins.values()];
      const positive = pins[0]!.net;
      const negative = pins[1]!.net;
      let voltage: number;
      try {
        voltage = parseQuantity(component.value, "V");
      } catch {
        continue;
      }
      if (measurements.has(negative)) {
        measurements.set(positive, (measurements.get(negative) as number) + voltage);
      } else if (measurements.has(positive)) {
        measurements.set(negative, (measurements.get(positive) as number) - voltage);
      }
    }
  }

  for (const component of ir.components.values()) {
    if (component.type === "ldo") {
      const outPin = component.pins.get("out");
      const vout = component.properties.get("vout");
      if (outPin && vout) {
        measurements.set(outPin.net, parseQuantity(vout, "V"));
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const solved = solveResistiveDividers([...ir.components.values()], measurements);
    for (const [node, value] of solved) {
      if (!measurements.has(node) || Math.abs((measurements.get(node) as number) - value) > 1e-9) {
        measurements.set(node, value);
        changed = true;
      }
    }
  }

  for (const component of ir.components.values()) {
    if (component.type === "generic_load") {
      // PARITY: Python `_test_current(...) or properties.get("current") or value`
      // is an or-chain that falls through EVERY falsy value including "" — `||`
      // reproduces it for strings exactly (`??` would stop at "").
      let current =
        testCurrent(test, component.id) ||
        component.properties.get("current") ||
        component.value ||
        "";
      const step = testLoadStep(test, component.id);
      if (step) {
        current = step[1];
      }
      if (current) {
        measurements.set(`i(${component.id})`, parseQuantity(current, "A"));
      }
    }
  }

  return measurements;
}

/**
 * Resistive-divider solve step, mirroring `_solve_resistive_dividers`. For each
 * unknown net touched by a resistor whose OTHER pin net is known, accumulate a
 * conductance-weighted voltage and return `weighted / conductance_sum`. Iterated
 * to a fixpoint by the caller. The unknown-set iteration order does not affect
 * the result (each unknown is solved independently from the KNOWN map snapshot).
 */
export function solveResistiveDividers(
  components: readonly Component[],
  known: Map<string, number>,
): Map<string, number> {
  const resistors = components.filter(
    (c) => c.type === "resistor" && c.pins.size >= 2 && c.value,
  );
  const unknowns = new Set<string>();
  for (const resistor of resistors) {
    for (const pin of resistor.pins.values()) {
      if (!known.has(pin.net)) unknowns.add(pin.net);
    }
  }
  const solved = new Map<string, number>();
  for (const net of unknowns) {
    let conductanceSum = 0.0;
    let weightedVoltage = 0.0;
    for (const resistor of resistors) {
      const pins = [...resistor.pins.values()];
      const nets = [pins[0]!.net, pins[1]!.net];
      if (!nets.includes(net)) continue;
      const other = nets[0] === net ? nets[1]! : nets[0]!;
      if (!known.has(other)) continue;
      const resistance = parseQuantity(resistor.value as string, "ohm");
      const conductance = 1.0 / resistance;
      conductanceSum += conductance;
      weightedVoltage += conductance * (known.get(other) as number);
    }
    if (conductanceSum > 0) {
      solved.set(net, weightedVoltage / conductanceSum);
    }
  }
  return solved;
}

function testCurrent(test: Test, componentId: string): string | null {
  return test.setup.get(`current:${componentId}`) ?? null;
}

function testLoadStep(
  test: Test,
  componentId: string,
): [string, string, string, string] | null {
  const encoded = test.setup.get(`load_step:${componentId}`);
  if (!encoded) return null;
  const parts = encoded.split(",");
  if (parts.length !== 4 || !parts[0] || !parts[1]) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

// --------------------------------------------------------------------------- //
// Signal statistics — verbatim port of the SignalStats machinery.
// --------------------------------------------------------------------------- //

/**
 * Statistics for a waveform, mirroring `_stats_for_samples`.
 *
 * TIE-BREAKING PARITY (the #14 parity trap): Python's `min(samples, key=value)`
 * returns the FIRST sample achieving the minimum; likewise `max`. A strict `<`
 * (min) / `>` (max) scan keeps the FIRST extremum, so a plateau's min/max time
 * is the first sample's time, not the last. `final` is the LAST sample's value.
 */
export function statsForSamples(samples: readonly Sample[], unit: string): SignalStats {
  const final = samples[samples.length - 1]![1];
  let minTime = samples[0]![0];
  let minValue = samples[0]![1];
  let maxTime = samples[0]![0];
  let maxValue = samples[0]![1];
  for (const [time, value] of samples) {
    // Strict `<` keeps the FIRST minimum (Python min() tie-break).
    if (value < minValue) {
      minValue = value;
      minTime = time;
    }
    // Strict `>` keeps the FIRST maximum (Python max() tie-break).
    if (value > maxValue) {
      maxValue = value;
      maxTime = time;
    }
  }
  return {
    final,
    min: minValue,
    max: maxValue,
    timeOfMin: minTime,
    timeOfMax: maxTime,
    unit,
  };
}

/**
 * DC-measurement stats, mirroring `_stats_from_measurements`: each measurement
 * becomes a flat SignalStats (final=min=max=value, time_of_min=time_of_max=0),
 * with the unit inferred from the signal name (`i(...)` -> A, else V).
 */
export function statsFromMeasurements(
  measured: Map<string, number>,
): Map<string, SignalStats> {
  const out = new Map<string, SignalStats>();
  for (const [name, value] of measured) {
    out.set(name, {
      final: value,
      min: value,
      max: value,
      timeOfMin: 0.0,
      timeOfMax: 0.0,
      unit: unitForSignal(name),
    });
  }
  return out;
}

/**
 * Serialize a SignalStats map to the report's `measurement_stats`, mirroring
 * `_serialize_stats`: `%.6g`-based `formatQuantity` for final/min/max, `%.9g`
 * (`formatG(t, 9)`) + "s" for the time fields.
 */
export function serializeStats(
  stats: Map<string, SignalStats>,
): Record<string, SerializedStats> {
  const out: Record<string, SerializedStats> = {};
  for (const [name, s] of stats) {
    out[name] = {
      final: formatQuantity(s.final, s.unit),
      min: formatQuantity(s.min, s.unit),
      max: formatQuantity(s.max, s.unit),
      time_of_min: `${formatG(s.timeOfMin, 9)}s`,
      time_of_max: `${formatG(s.timeOfMax, 9)}s`,
    };
  }
  return out;
}

function unitForSignal(name: string): string {
  return name.startsWith("i(") ? "A" : "V";
}

// --------------------------------------------------------------------------- //
// Assertion evaluation — verbatim port of `_evaluate_assertions`.
// --------------------------------------------------------------------------- //

/**
 * Evaluate the test's `assert_voltage` / `assert_current` constraints against the
 * measured DC values + waveform stats, mirroring `_evaluate_assertions`.
 *
 * Same subjects (`i(<component>)` for currents), same default bounds
 * (`-1e99<unit>` / `1e99<unit>`), same pass/fail (observed_min < min OR
 * observed_max > max), and the SAME diagnostic codes — `ASSERT_NO_MEASUREMENT`
 * when the subject has no measurement, `ASSERT_FAILED` when out of range. The
 * `builder` seeds ids at `diag_00001` (a fresh DiagnosticBuilder, as the oracle
 * does inside this function).
 */
export function evaluateAssertions(
  test: Test,
  measured: Map<string, number>,
  stats: Map<string, SignalStats>,
): ReportDiagnostic[] {
  const builder = new DiagnosticBuilder();
  const diagnostics: ReportDiagnostic[] = [];
  for (const assertion of test.assertions) {
    const op = assertion["op"];
    if (op !== "assert_voltage" && op !== "assert_current") continue;
    const subject =
      op === "assert_voltage"
        ? assertion["net"] ?? ""
        : `i(${assertion["component"] ?? ""})`;
    const unit = op === "assert_voltage" ? "V" : "A";
    const value = measured.get(subject);
    const signalStats = stats.get(subject);
    const minValue = parseQuantity(assertion["min"] ?? `-1e99${unit}`, unit);
    const maxValue = parseQuantity(assertion["max"] ?? `1e99${unit}`, unit);
    if (value === undefined) {
      diagnostics.push(
        builder.make(
          "error",
          "analog",
          "ASSERT_NO_MEASUREMENT",
          `No measurement available for ${subject}.`,
          [test.id, subject],
        ),
      );
      continue;
    }
    const observedMin = signalStats ? signalStats.min : value;
    const observedMax = signalStats ? signalStats.max : value;
    if (observedMin < minValue || observedMax > maxValue) {
      const observed: Record<string, unknown> = {
        final: formatQuantity(value, unit),
        min: formatQuantity(observedMin, unit),
        max: formatQuantity(observedMax, unit),
      };
      if (signalStats) {
        observed["time_of_min"] = `${formatG(signalStats.timeOfMin, 9)}s`;
        observed["time_of_max"] = `${formatG(signalStats.timeOfMax, 9)}s`;
      }
      diagnostics.push(
        builder.make(
          "error",
          "analog",
          "ASSERT_FAILED",
          `${subject} was outside expected range.`,
          [test.id, subject],
          observed,
          { min: assertion["min"] ?? null, max: assertion["max"] ?? null },
          [
            "Adjust component values",
            "Check source/load setup",
            "Check expected assertion limits",
          ],
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * Mirror of diagnostics.py `DiagnosticBuilder`: monotone `diag_00001`,
 * `diag_00002`, ... ids, per-builder. Assertion diagnostics use a fresh builder
 * (ids restart at 1) exactly as `_evaluate_assertions` does.
 */
export class DiagnosticBuilder {
  private nextId = 1;

  make(
    severity: "info" | "warning" | "error",
    domain: string,
    code: string,
    message: string,
    relatedElements: string[] = [],
    observed: Record<string, unknown> = {},
    expected: Record<string, unknown> = {},
    suggestedActions: string[] = [],
  ): ReportDiagnostic {
    const diagnostic: ReportDiagnostic = {
      id: `diag_${String(this.nextId).padStart(5, "0")}`,
      severity,
      domain,
      code,
      message,
      related_elements: relatedElements,
      observed,
      expected,
      suggested_actions: suggestedActions,
    };
    this.nextId += 1;
    return diagnostic;
  }
}

// --------------------------------------------------------------------------- //
// Probe-net resolution + waveform extraction.
// --------------------------------------------------------------------------- //

/**
 * The nets whose transient waveforms are extracted for stats, mirroring
 * `simulate_analog`'s `all_probe_nets = sorted(assertion_nets | extra_probe_nets)`:
 * the `assert_voltage` nets UNION the profile's included-subsystem probe nets,
 * sorted by Python string order (Unicode code point, == JS default for ASCII).
 */
export function probeNets(ir: SystemIR, test: Test, profileId: string): string[] {
  const assertionNets = new Set<string>();
  for (const a of test.assertions) {
    if (a["op"] === "assert_voltage" && a["net"]) assertionNets.add(a["net"]);
  }
  const extraProbeNets = new Set<string>();
  const profile = ir.simulation_profiles.get(profileId);
  if (profile) {
    const subsystems = new Map(ir.analog.map((s) => [s.id, s]));
    for (const subId of profile.included_subsystems) {
      const sub = subsystems.get(subId);
      if (sub) {
        for (const probe of sub.probes) extraProbeNets.add(probe.net);
      }
    }
  }
  const all = new Set<string>([...assertionNets, ...extraProbeNets]);
  return [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Extract `(time, value)` samples for one probed net from the engine's tables,
 * pairing the `time` vector with the net's `v(<net>)` vector. ngspice lower-cases
 * node names, so matching is case-insensitive on the vector name. Ground nets
 * (`gnd`/`0`) have no `v(...)` vector; they get no waveform stats (they stay DC).
 * Returns null when the net has no readable table (falls back to DC stats).
 */
export function samplesForNet(
  tables: readonly WaveTableLike[],
  net: string,
): Sample[] | null {
  const vName = `v(${spiceNet(net)})`.toLowerCase();
  const timeTable = findTable(tables, "time");
  const valueTable = findTable(tables, vName);
  if (!valueTable || valueTable.values.length === 0) return null;
  const n = valueTable.values.length;
  const samples: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const t = timeTable && i < timeTable.values.length ? (timeTable.values[i] as number) : i;
    samples.push([t, valueTable.values[i] as number]);
  }
  return samples;
}

function findTable(
  tables: readonly WaveTableLike[],
  nameLower: string,
): WaveTableLike | null {
  for (const t of tables) {
    if (t.name.toLowerCase() === nameLower) return t;
  }
  return null;
}

/** Mirror of spice.py `_spice_net`: `gnd`/`0` (any case) -> `0`, else verbatim. */
function spiceNet(net: string): string {
  const lower = net.toLowerCase();
  return lower === "gnd" || lower === "0" ? "0" : net;
}

// --------------------------------------------------------------------------- //
// Convergence section — verbatim port of `_convergence_section` for the
// browser's honest AS-WRITTEN (rung-1-only) run.
// --------------------------------------------------------------------------- //

/**
 * The browser's `convergence` section. The eecircuit engine runs the netlist
 * AS-WRITTEN only (no #45 ladder), so the honest section has a SINGLE rung-1
 * attempt.
 *
 *  - engineAttempted && converged  -> the rung-1 as-written success the corpus
 *    reports for every design that converges natively on rung 1
 *    (`aids_required:false, rung:1, terminal:false, note:null`). Byte-identical
 *    to the oracle's rung-1 reports.
 *  - engineAttempted && !converged -> the engine RAN as-written and did NOT
 *    converge (e.g. eecircuit's singular-matrix on a design native ngspice
 *    solves) and the browser has no ladder to climb. HONEST `terminal:true` with
 *    the topology-directed note (matching `_convergence_section`'s terminal
 *    branch). This is where a design diverges from the oracle — DISCLOSED, not
 *    papered over as a missing engine. Browser-side ladder is future work.
 *  - !engineAttempted -> engine unavailable: a single not-converged rung-1
 *    attempt flagged `ngspice_missing`, no note (the DC-fallback path owns that
 *    case), exactly as the oracle's ladder returns for a missing binary.
 */
export function convergenceSection(engineAttempted: boolean, converged: boolean): ConvergenceSection {
  if (!engineAttempted) {
    return {
      attempts: [
        { rung: 1, name: "as-written", options: [], converged: false, ngspice_missing: true },
      ],
      converged: false,
      rung: null,
      aids_required: false,
      terminal: false,
      note: null,
    };
  }
  const attempts: ConvergenceAttempt[] = [
    { rung: 1, name: "as-written", options: [], converged },
  ];
  if (converged) {
    return {
      attempts,
      converged: true,
      rung: 1,
      aids_required: false,
      terminal: false,
      note: null,
    };
  }
  // Engine ran as-written but did not converge; no ladder to climb (rung 1 only).
  return {
    attempts,
    converged: false,
    rung: null,
    aids_required: false,
    terminal: true,
    note:
      "did not converge after every numerical aid; this usually means a " +
      "topology problem (floating node / missing DC path to ground), not a " +
      "value problem - inspect the topology before adjusting values",
  };
}

// --------------------------------------------------------------------------- //
// Report assembly — mirroring the per-test dict `simulate_analog` builds.
// --------------------------------------------------------------------------- //

/**
 * Build ONE test's report from the browser run, mirroring the per-test body of
 * `simulate_analog`.
 *
 * Flow (order-faithful to the oracle):
 *   1. `measured = measureDc(ir, test)` + flat `stats`.
 *   2. Waveform stats for the probed nets overwrite the flat stats + the
 *      measured VALUE (`stats.update(waveform_stats)` / `measured.update(...)`).
 *   3. `usedEngine` = engine attempted AND produced probe waveforms.
 *   4. Convergence section (honest, as-written): converged (rung 1) when the
 *      engine produced data; `terminal` when it ran but did not; `ngspice_missing`
 *      when the engine was never available.
 *   5. Assertions -> diagnostics; status is `failed` iff any diagnostic.
 *   6. backend label: `ngspice` when the transient produced data, else
 *      `builtin_dc_fallback` (the measurements come from the analytic DC pass; an
 *      as-written non-convergence is disclosed via `convergence.terminal`, not a
 *      separate backend label).
 *
 * `artifacts` are the stable temp-relative POSIX forms the corpus commits
 * (`spice/main.cir`, `spice/probes.json`, `waveforms/<test>_<net>.csv`), matching
 * `_normalize_report_paths` output.
 */
export function buildReport(inputs: ReportInputs): SimulationReport {
  const { ir, test, profileId, waveTables } = inputs;
  const engineAttempted = inputs.engineAttempted ?? true;

  const allProbeNets = probeNets(ir, test, profileId);

  const measured = measureDc(ir, test);
  const stats = statsFromMeasurements(measured);

  // Waveform stats for probed nets (only those the engine produced tables for).
  const waveformStats = new Map<string, SignalStats>();
  for (const net of allProbeNets) {
    const samples = samplesForNet(waveTables, net);
    if (samples && samples.length > 0) {
      waveformStats.set(net, statsForSamples(samples, "V"));
    }
  }
  const usedEngine = engineAttempted && waveformStats.size > 0;

  // stats.update(waveform_stats) + measured.update({name: signal.final}).
  for (const [name, signal] of waveformStats) {
    stats.set(name, signal);
    measured.set(name, signal.final);
  }

  const convergence = convergenceSection(engineAttempted, usedEngine);

  const assertionDiagnostics = evaluateAssertions(test, measured, stats);
  const diagnostics = assertionDiagnostics;
  const testStatus: "passed" | "failed" = diagnostics.length > 0 ? "failed" : "passed";
  const backend = usedEngine ? "ngspice" : "builtin_dc_fallback";

  const waveformArtifacts = allProbeNets.map((net) => `waveforms/${test.id}_${net}.csv`);
  const artifacts = ["spice/main.cir", "spice/probes.json", ...waveformArtifacts];

  return {
    profile: profileId,
    test: test.id,
    status: testStatus,
    backend,
    convergence,
    measurements: mapToObject(
      measured,
      (value, name) => formatQuantity(value, unitForSignal(name)),
    ),
    measurement_stats: serializeStats(stats),
    diagnostics,
    artifacts,
  };
}

function mapToObject<V, R>(
  map: Map<string, V>,
  transform: (value: V, key: string) => R,
): Record<string, R> {
  const out: Record<string, R> = {};
  for (const [key, value] of map) out[key] = transform(value, key);
  return out;
}

/**
 * Resolve the default ngspice-backed simulation profile for a design, mirroring
 * `export_golden.py`'s `_default_ngspice_profile`: the profile flagged
 * `default="true"` (else the first declared), but only if it lists the `ngspice`
 * backend. Returns null when there is no such profile.
 */
export function defaultNgspiceProfile(ir: SystemIR): string | null {
  let defaultId: string | null = null;
  for (const [pid, p] of ir.simulation_profiles) {
    if (p.default) {
      defaultId = pid;
      break;
    }
  }
  if (defaultId === null) {
    const first = ir.simulation_profiles.keys().next();
    defaultId = first.done ? null : (first.value as string);
  }
  if (defaultId === null) return null;
  const profile = ir.simulation_profiles.get(defaultId);
  if (!profile || !profile.backends.includes("ngspice")) return null;
  return defaultId;
}

// --------------------------------------------------------------------------- //
// JSON serialization — reproduce the exporter's `json.dumps(sort_keys=True)`.
// --------------------------------------------------------------------------- //

/**
 * Serialize a report to the EXACT string form the corpus commits:
 * `json.dumps(report, indent=2, sort_keys=True) + "\n"`. Python sorts object
 * keys recursively (Unicode code point == JS default for ASCII keys), indents
 * with two spaces, and appends a trailing newline. This is the string the
 * report-schema parity test diffs against `report/reports/<test>.json`.
 */
export function serializeReportJson(report: SimulationReport): string {
  return pyJsonDumps(report, 2) + "\n";
}

/**
 * A `json.dumps(obj, indent=n, sort_keys=True)` work-alike for the plain-JSON
 * report objects this module produces. Object keys are sorted recursively; the
 * separators (`": "` after a key, `","` between items) and the indentation match
 * CPython's `indent=` form. Numbers never appear as bare values in a report (all
 * numeric fields are pre-formatted strings), so no float-repr divergence is
 * possible here; booleans/null/strings/arrays/objects are all that occur.
 */
export function pyJsonDumps(value: unknown, indent: number): string {
  return dumpValue(value, indent, 0);
}

function dumpValue(value: unknown, indent: number, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // Reports carry no bare numbers, but be faithful if one appears.
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return dumpArray(value, indent, depth);
  if (typeof value === "object") return dumpObject(value as Record<string, unknown>, indent, depth);
  return "null";
}

function dumpArray(arr: unknown[], indent: number, depth: number): string {
  if (arr.length === 0) return "[]";
  const pad = " ".repeat(indent * (depth + 1));
  const closePad = " ".repeat(indent * depth);
  const items = arr.map((v) => pad + dumpValue(v, indent, depth + 1));
  return "[\n" + items.join(",\n") + "\n" + closePad + "]";
}

function dumpObject(obj: Record<string, unknown>, indent: number, depth: number): string {
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return "{}";
  const pad = " ".repeat(indent * (depth + 1));
  const closePad = " ".repeat(indent * depth);
  const items = keys.map(
    (k) => pad + JSON.stringify(k) + ": " + dumpValue(obj[k], indent, depth + 1),
  );
  return "{\n" + items.join(",\n") + "\n" + closePad + "}";
}

// --------------------------------------------------------------------------- //
// Waveform CSV export — reproduce the oracle's canonical waveform CSV FORMAT.
// --------------------------------------------------------------------------- //

/**
 * Default downsample cap, mirroring `_write_canonical_waveform`'s `max_points`.
 */
const CANONICAL_MAX_POINTS = 500;

/**
 * Export a probed net's samples as a CSV byte-identical in FORMAT to the
 * oracle's canonical waveform CSVs (`_write_canonical_waveform`):
 *
 *   - header row `time_s,v(<net>)` (the net rendered via `spiceNet`: gnd/0 -> 0);
 *   - one `<time>,<value>` row per sample, floats rendered by `formatNumber`
 *     (CPython `repr`, which Python's `csv.writer` uses via `str()`);
 *   - LF line endings, trailing newline (the exporter's `_write_text_lf` form);
 *   - downsampled to <= `maxPoints` by the SAME stride rule
 *     (`samples[::step]`, step = floor(len/max)), always retaining the final
 *     sample.
 *
 * The VALUES will differ from the corpus (eecircuit ngspice 45.2 vs native 42 —
 * that is #15's tolerance domain); the FORMAT (header, column order, float
 * rendering, row structure) is what this reproduces exactly.
 */
export function waveformCsv(
  net: string,
  samples: readonly Sample[],
  maxPoints: number = CANONICAL_MAX_POINTS,
): string {
  const reduced = downsample(samples, maxPoints);
  const lines: string[] = [`time_s,v(${spiceNet(net)})`];
  for (const [time, value] of reduced) {
    lines.push(`${formatNumber(time)},${formatNumber(value)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Mirror of `_write_canonical_waveform`'s downsample: when `samples.length >
 * maxPoints`, take every `step`-th sample (`step = floor(len / maxPoints)`,
 * i.e. Python `samples[::step]`) and append the true final sample if the stride
 * dropped it. Otherwise return the samples unchanged.
 */
function downsample(samples: readonly Sample[], maxPoints: number): Sample[] {
  if (samples.length <= maxPoints) return [...samples];
  const step = Math.floor(samples.length / maxPoints);
  const reduced: Sample[] = [];
  for (let i = 0; i < samples.length; i += step) reduced.push(samples[i]!);
  const last = samples[samples.length - 1]!;
  const tail = reduced[reduced.length - 1]!;
  if (tail[0] !== last[0] || tail[1] !== last[1]) reduced.push(last);
  return reduced;
}
