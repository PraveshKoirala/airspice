/**
 * Local (zero-backend) simulation pipeline (issue #14 deliverable 4).
 *
 * Wires the full browser Run flow behind the engine facade (#10), with NO
 * server:
 *
 *   compile (air-ts spice #9) -> prepare netlist (sim-wasm #13)
 *     -> simulate (SimClient / WASM ngspice worker)
 *       -> report (air-ts report.ts #14)  -> retain waveforms (typed arrays)
 *
 * The output is the SAME shape the backend's `/simulate` returns
 * (`{ profile, status, reports }`), so the existing Simulation tab renders it
 * unchanged. The report objects are schema-identical to the Python oracle's
 * (buildReport), so the agent tools (#18) that key off this schema work against
 * either engine.
 *
 * WORKER-ONLY + TYPED ARRAYS (epic #12 invariants): the WASM engine runs only in
 * sim-wasm's Web Worker; this module is the main-thread orchestrator. Waveform
 * samples arrive as transferred `Float64Array`s and are retained in the waveform
 * store as typed arrays — never converted to `number[]` / JSON in the hot path.
 *
 * CONVERGENCE HONESTY (issue #45 scope): the browser engine runs the netlist
 * AS-WRITTEN (no #45 ladder). `engineRan`/converged is derived from whether the
 * transient produced readable probe data; buildReport turns that into the honest
 * rung-1 convergence section (see report.ts).
 */

import { parse, compileSpice, defaultNgspiceProfile, buildReport, probeNets } from "air-ts";
import type { SystemIR, Test, SimulationReport, WaveTableLike } from "air-ts";
import { SimClient, prepareNetlist } from "sim-wasm";
import type { SimEvent, WaveTable } from "sim-wasm";
import { retainRun, type RetainedWaveform, type RunWaveforms } from "./waveformStore";

/** The result of a local simulation run — the backend `/simulate` shape + runId. */
export interface LocalSimulationResult {
  /** The default ngspice profile that was run. */
  profile: string;
  /** "passed" iff every test's report passed. */
  status: "passed" | "failed";
  /** One report per test in the profile (schema-identical to the oracle). */
  reports: SimulationReport[];
  /** The run id the waveform store is keyed by (for chart / CSV export). */
  runId: string;
  /** Non-fatal per-test engine notes (stderr summaries / errors), for the log. */
  notes: string[];
}

let sharedClient: SimClient | null = null;

/** Lazily create the shared SimClient (one WASM worker for the app session). */
function client(): SimClient {
  if (!sharedClient) sharedClient = new SimClient();
  return sharedClient;
}

/** Dispose the shared engine client (called from the local engine's dispose). */
export function disposeSimulateClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}

/** Monotone run-id source so each Run keys its own waveform-store entry. */
let runCounter = 0;

/**
 * Run the design's default ngspice profile entirely in the browser and return
 * the report + retained-waveform run id. Throws if the design has no
 * ngspice-backed profile (the caller surfaces that to the user).
 *
 * CANCELLATION (issue #18 Stop button; #13 ADR 0011): an optional AbortSignal
 * cancels an in-flight run. Because eecircuit cannot interrupt a running
 * transient, cancel TERMINATES + RESPAWNS the worker (SimClient.cancel), so the
 * abort returns in well under the 500ms acceptance bar and the next run gets a
 * pristine engine. On abort this rejects with an `aborted` error the agent tool
 * runtime turns into a "simulation_canceled" tool result.
 */
export async function simulateLocal(
  xml: string,
  signal?: AbortSignal,
): Promise<LocalSimulationResult> {
  if (signal?.aborted) throw new DOMException("Simulation aborted", "AbortError");
  const ir: SystemIR = parse(xml);
  const profileId = defaultNgspiceProfile(ir);
  if (profileId === null) {
    throw new Error("This design has no default simulation profile with an ngspice backend.");
  }
  const profile = ir.simulation_profiles.get(profileId)!;

  const runId = `local-sim-${++runCounter}`;
  const runWaveforms: RunWaveforms = { runId, waveforms: new Map() };
  const reports: SimulationReport[] = [];
  const notes: string[] = [];
  let overallStatus: "passed" | "failed" = "passed";

  for (const testId of profile.tests) {
    if (signal?.aborted) throw new DOMException("Simulation aborted", "AbortError");
    const test = ir.tests.get(testId);
    if (!test) {
      notes.push(`skipped unknown test ${testId}`);
      continue;
    }
    const { report, tables } = await runOneTest(ir, test, profileId, runId, notes, signal);
    reports.push(report);
    if (report.status === "failed") overallStatus = "failed";
    retainTables(runWaveforms, test.id, tables, probeNets(ir, test, profileId));
  }

  retainRun(runWaveforms);
  return { profile: profileId, status: overallStatus, reports, runId, notes };
}

/**
 * Compile + simulate ONE test, returning its report and the raw WaveTables (for
 * retention). The netlist is compiled by air-ts (#9), transport-adapted by
 * sim-wasm's `prepareNetlist` (strip the host `.control` block + ASCII rawfile
 * option), and run in the WASM worker. Probes request the `time` axis plus each
 * probed net's `v(net)` vector so buildReport can compute stats.
 */
async function runOneTest(
  ir: SystemIR,
  test: Test,
  profileId: string,
  runId: string,
  notes: string[],
  signal?: AbortSignal,
): Promise<{ report: SimulationReport; tables: WaveTable[] }> {
  const extraProbes = subsystemProbeNets(ir, profileId);
  const { netlist } = compileSpice(ir, test, { extraProbes });
  const prepared = prepareNetlist(netlist);

  const nets = probeNets(ir, test, profileId);
  const probeVectors = ["time", ...nets.map((n) => `v(${spiceNet(n)})`)];
  const probes = probeVectors.map((v) => ({ id: v, vector: v }));

  const simId = `${runId}-${test.id}`;
  // Stop button: cancel this run's worker (terminate + respawn, ADR 0011) the
  // moment the signal fires, so the abort returns in well under 500ms.
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    client().cancel(simId);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let tables: WaveTable[] = [];
  // The engine was ATTEMPTED iff the worker produced a terminal event (result or
  // error) — i.e. the WASM engine loaded and ran. It is UNattempted only on an
  // infra failure where the worker never responded. This splits the honest
  // convergence cases: attempted-but-no-data -> terminal (as-written did not
  // converge, e.g. eecircuit singular-matrix); unattempted -> ngspice_missing.
  let engineAttempted = false;
  let errorLine: string | null = null;
  const stderr: string[] = [];

  try {
    for await (const ev of client().run({ id: simId, netlist: prepared, probes }) as AsyncIterable<SimEvent>) {
      if (ev.type === "result") {
        engineAttempted = true;
        tables = ev.tables;
      } else if (ev.type === "error") {
        engineAttempted = true;
        errorLine = `${ev.diagnostic.code}: ${ev.diagnostic.message}`;
      } else if (ev.type === "stderr") {
        stderr.push(ev.line);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  // A canceled run surfaces as an abort to the caller (the agent tool runtime
  // turns it into a "simulation_canceled" result). The cancel already settled
  // the stream with a SIM-CANCELED error above.
  if (aborted || signal?.aborted) {
    throw new DOMException("Simulation aborted", "AbortError");
  }

  if (errorLine) {
    notes.push(`${test.id}: ${errorLine}`);
    if (stderr.length > 0) notes.push(`${test.id} stderr: ${stderr.slice(-3).join(" | ")}`);
  }

  const report = buildReport({
    ir,
    test,
    profileId,
    waveTables: tables as unknown as WaveTableLike[],
    engineAttempted,
  });
  return { report, tables };
}

/** Retain each probed net's typed-array samples for this test into the store. */
function retainTables(
  run: RunWaveforms,
  testId: string,
  tables: readonly WaveTable[],
  nets: readonly string[],
): void {
  const timeTable = tables.find((t) => t.name.toLowerCase() === "time");
  const time = timeTable ? timeTable.values : new Float64Array(0);
  for (const net of nets) {
    const vName = `v(${spiceNet(net)})`.toLowerCase();
    const vTable = tables.find((t) => t.name.toLowerCase() === vName);
    if (!vTable || vTable.values.length === 0) continue;
    const wf: RetainedWaveform = {
      net,
      test: testId,
      // Typed arrays retained as-is (transferred from the worker) — no JSON.
      time,
      values: vTable.values,
    };
    run.waveforms.set(`${testId}_${net}`, wf);
  }
}

/** The profile's included-subsystem probe nets (extra probes for compileSpice). */
function subsystemProbeNets(ir: SystemIR, profileId: string): string[] {
  const profile = ir.simulation_profiles.get(profileId);
  if (!profile) return [];
  const subsystems = new Map(ir.analog.map((s) => [s.id, s]));
  const nets = new Set<string>();
  for (const subId of profile.included_subsystems) {
    const sub = subsystems.get(subId);
    if (sub) for (const probe of sub.probes) nets.add(probe.net);
  }
  return [...nets];
}

/** Mirror of spice.py `_spice_net`: `gnd`/`0` (any case) -> `0`, else verbatim. */
function spiceNet(net: string): string {
  const lower = net.toLowerCase();
  return lower === "gnd" || lower === "0" ? "0" : net;
}
