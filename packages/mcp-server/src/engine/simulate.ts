/**
 * Node simulation wiring for the MCP server (issue #40).
 *
 * This is the Node analogue of `packages/ui/src/engine/simulate.ts`: the SAME
 * air-ts (#9 compile / #14 report) + sim-wasm (#13 ngspice worker) pipeline the
 * browser runs, differing ONLY in transport — it backs `SimClient` with the Node
 * `worker_threads` factory (`sim-wasm/node`). (The browser retains decimated
 * waveforms for its charts; the stateless MCP server exposes no waveform tool,
 * so it retains nothing — the report is the whole product.)
 *
 * This module contains NO simulation ALGORITHM: it compiles with air-ts, runs
 * ngspice inside sim-wasm's worker, and builds the report with air-ts's
 * `buildReport`. It is transport + wiring, exactly like the UI's copy — the
 * EngineHooks seam (agent #18) is deliberately designed so each host app
 * (browser UI, this MCP server) supplies its own sim-wasm binding; the engine
 * packages own every bit of the logic.
 */

import {
  parse,
  compileSpice,
  defaultNgspiceProfile,
  buildReport,
  probeNets,
} from "air-ts";
import type {
  SystemIR,
  Test,
  SimulationReport,
  WaveTableLike,
  LadderInput,
} from "air-ts";
import { SimClient, prepareNetlist } from "sim-wasm";
import { nodeWorkerFactory } from "sim-wasm/node";
import type { SimEvent, WaveTable } from "sim-wasm";

/** The result of one Node simulation run — the backend `/simulate` shape. */
export interface NodeSimulationResult {
  profile: string;
  status: "passed" | "failed";
  reports: SimulationReport[];
  notes: string[];
}

// One shared WASM worker for the server's lifetime (mirrors the UI's shared
// SimClient). Lazily created so importing this module has no cold-start cost.
let sharedClient: SimClient | null = null;
function client(): SimClient {
  if (!sharedClient) sharedClient = new SimClient(nodeWorkerFactory);
  return sharedClient;
}

/** Preload/warm the WASM engine (used by the cold-start measurement + cosim). */
export function simClient(): SimClient {
  return client();
}

/** Dispose the shared engine client (clean shutdown). */
export function disposeSimClient(): void {
  sharedClient?.dispose();
  sharedClient = null;
}

// Monotone run-id source: names each run's worker correlation id (simId).
let runCounter = 0;

/** Mirror of spice.py `_spice_net`: `gnd`/`0` (any case) → `0`, else verbatim. */
function spiceNet(net: string): string {
  const lower = net.toLowerCase();
  return lower === "gnd" || lower === "0" ? "0" : net;
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

function aborted(): Error {
  const err = new Error("Simulation aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Run a design's ngspice profile in Node and return the report.
 * `requestedProfileId` selects a specific profile; omit it to run the design's
 * default ngspice profile. Throws if the design (or requested profile) has no
 * ngspice-backed profile (the caller surfaces that). `signal` cancels an
 * in-flight run (worker terminate + respawn, ADR 0011).
 */
export async function simulateDesign(
  xml: string,
  signal: AbortSignal,
  requestedProfileId?: string,
): Promise<NodeSimulationResult> {
  if (signal.aborted) throw aborted();
  const ir: SystemIR = parse(xml);
  let profileId: string | null;
  if (requestedProfileId !== undefined) {
    if (!ir.simulation_profiles.has(requestedProfileId)) {
      throw new Error(`Unknown simulation profile '${requestedProfileId}'.`);
    }
    profileId = requestedProfileId;
  } else {
    profileId = defaultNgspiceProfile(ir);
    if (profileId === null) {
      throw new Error(
        "This design has no default simulation profile with an ngspice backend.",
      );
    }
  }
  const profile = ir.simulation_profiles.get(profileId);
  if (!profile) throw new Error(`Unknown profile '${profileId}'.`);

  const runId = `mcp-sim-${++runCounter}`;
  const reports: SimulationReport[] = [];
  const notes: string[] = [];
  let overallStatus: "passed" | "failed" = "passed";

  for (const testId of profile.tests) {
    if (signal.aborted) throw aborted();
    const test = ir.tests.get(testId);
    if (!test) {
      notes.push(`skipped unknown test ${testId}`);
      continue;
    }
    const report = await runOneTest(ir, test, profileId, runId, notes, signal);
    reports.push(report);
    if (report.status === "failed") overallStatus = "failed";
  }

  return { profile: profileId, status: overallStatus, reports, notes };
}

async function runOneTest(
  ir: SystemIR,
  test: Test,
  profileId: string,
  runId: string,
  notes: string[],
  signal: AbortSignal,
): Promise<SimulationReport> {
  const extraProbes = subsystemProbeNets(ir, profileId);
  const { netlist } = compileSpice(ir, test, { extraProbes });
  const prepared = prepareNetlist(netlist);

  const nets = probeNets(ir, test, profileId);
  const probeVectors = ["time", ...nets.map((n) => `v(${spiceNet(n)})`)];
  const probes = probeVectors.map((v) => ({ id: v, vector: v }));

  const simId = `${runId}-${test.id}`;
  let wasAborted = false;
  const onAbort = (): void => {
    wasAborted = true;
    client().cancel(simId);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let tables: WaveTable[] = [];
  let engineAttempted = false;
  let errorLine: string | null = null;
  const stderr: string[] = [];
  let ladderInput: LadderInput | undefined;

  try {
    for await (const ev of client().run({ id: simId, netlist: prepared, probes }) as AsyncIterable<SimEvent>) {
      if (ev.type === "result") {
        engineAttempted = true;
        tables = ev.tables;
        if (ev.ladder) ladderInput = ev.ladder;
      } else if (ev.type === "error") {
        engineAttempted = true;
        errorLine = `${ev.diagnostic.code}: ${ev.diagnostic.message}`;
        if (ev.ladder) ladderInput = ev.ladder;
      } else if (ev.type === "stderr") {
        stderr.push(ev.line);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  if (wasAborted || signal.aborted) throw aborted();

  if (errorLine) {
    notes.push(`${test.id}: ${errorLine}`);
    if (stderr.length > 0) notes.push(`${test.id} stderr: ${stderr.slice(-3).join(" | ")}`);
  }

  return buildReport(
    ladderInput === undefined
      ? { ir, test, profileId, waveTables: tables as unknown as WaveTableLike[], engineAttempted }
      : { ir, test, profileId, waveTables: tables as unknown as WaveTableLike[], engineAttempted, ladder: ladderInput },
  );
}
