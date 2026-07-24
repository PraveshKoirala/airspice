/// <reference lib="webworker" />
/**
 * sim-wasm engine Web Worker (issue #13; epic #12 binding decision 1).
 *
 * This is the ONLY place the WASM ngspice engine (eecircuit-engine) is loaded
 * and run. It NEVER executes on the main thread (AGENTS.md rule 8). The engine
 * is lazy-imported (dynamic `import()`) on first use so the ~19MB WASM is a
 * separate Vite chunk that is NOT in the initial page-load bundle (issue
 * deliverable 6) -- the worker module itself is tiny; the heavy dependency only
 * loads when `preload`/`run` first needs it.
 *
 * Cancellation model (ADR 0011): eecircuit-engine is FIRE-AND-FORGET -- `runSim`
 * has no interrupt. So mid-run cancellation is done by the CLIENT terminating
 * this worker and spawning a fresh one (see client.ts). This worker therefore
 * does not implement a `cancel` handler for an *in-flight* run; it handles
 * `cancel` only for a not-yet-started/idle run (a courtesy no-op that reports
 * `canceled`). The hard guarantee "a canceled run leaves the engine usable" is
 * satisfied by respawn: the terminated worker's engine dies with it and the new
 * worker starts clean.
 *
 * eecircuit types are confined to this file + result.ts; nothing they touch is
 * re-exported to the UI.
 */

import type {
  EngineCapabilities,
  ProbeSpec,
  SimEvent,
  SimLadderOutcome,
  WorkerInbound,
  WorkerOutbound,
} from "./protocol.js";
import { classifyStderr } from "./diagnostics.js";
import { toWaveTables } from "./result.js";
import { CONVERGENCE_LADDER, buildRungNetlist, type LadderRung } from "./ladder.js";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// eecircuit-engine version + the ngspice it was built from (ADR 0011 evidence).
const ENGINE_NAME = "eecircuit-engine";
const ENGINE_VERSION = "1.7.0";
const NGSPICE_VERSION = "45.2";

/** Lazily-created singleton engine instance for this worker. */
type EEChip = {
  start(): Promise<void>;
  setNetList(input: string): void;
  runSim(): Promise<unknown>;
  getInfo(): string;
  getInitInfo(): string;
  getError(): string[];
  setOutputEvent?(cb: (out: string) => void): void;
};

let enginePromise: Promise<EEChip> | null = null;

/**
 * Load + start the engine on first use. The dynamic import is what makes the
 * WASM a lazy Vite chunk. Idempotent: repeated calls share one instance.
 */
async function getEngine(): Promise<EEChip> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = await import("eecircuit-engine");
      const sim = new mod.Simulation() as unknown as EEChip;
      await sim.start();
      return sim;
    })();
  }
  return enginePromise;
}

function post(msg: WorkerOutbound, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

function emit(event: SimEvent, transfer?: Transferable[]): void {
  post({ kind: "event", event }, transfer);
}

function capabilities(): EngineCapabilities {
  return {
    control: false, // eecircuit is fire-and-forget (ADR 0011). #88 flips this.
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    ngspiceVersion: NGSPICE_VERSION,
  };
}

/**
 * Split ngspice's combined info/error text into individual lines and stream them
 * as stderr/stdout events. eecircuit exposes `getInfo()` (the full transcript,
 * incl. the run banner + any messages) and `getError()` (the lines it flagged as
 * errors). We stream the error lines as `stderr` and the rest of the transcript
 * as `stdout`, so NOTHING is swallowed.
 */
function streamOutput(id: string, info: string, errors: string[]): void {
  const errSet = new Set(errors.map((e) => e.trim()).filter(Boolean));
  for (const raw of info.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (errSet.has(line.trim())) emit({ id, type: "stderr", line });
    else emit({ id, type: "stdout", line });
  }
  // Any error line not present in the transcript is still streamed.
  for (const e of errors) {
    const line = e.trim();
    if (line && !info.includes(line)) emit({ id, type: "stderr", line });
  }
}

/**
 * One rung's execution against the eecircuit engine. Returns the raw result,
 * an error diagnostic (if the rung failed / did not converge), and the tables
 * it produced (empty on failure). Kept as a small pure-ish helper so the
 * ladder driver in `handleRun` reads as: "for each rung, runRung, decide
 * converged, break or climb".
 *
 * A rung is treated as CONVERGED when eecircuit returned without throwing
 * AND `classifyStderr` on the union of transcripts did NOT surface an
 * error-severity diagnostic AND the tables actually contain data. This
 * mirrors the native oracle's rule: "ngspice exits 0 AND its transient
 * produced readable waveform data" (simulator.py `run_convergence_ladder`).
 */
async function runRung(
  engine: EEChip,
  rungNetlist: string,
  probes: ProbeSpec[] | undefined,
  liveLines: string[],
): Promise<{
  ok: boolean;
  tables: ReturnType<typeof toWaveTables>["tables"];
  transfer: ArrayBufferLike[];
  errorDiag: import("./protocol").SimDiagnostic | null;
  linesBefore: number;
}> {
  // Snapshot how many live lines existed BEFORE this rung so `classifyStderr`
  // sees only this rung's slice — a stale "singular matrix" from an earlier
  // failed rung must NOT sink a later rung that produced clean output.
  const linesBefore = liveLines.length;

  let raw: unknown;
  try {
    engine.setNetList(rungNetlist);
    raw = await engine.runSim();
  } catch (err) {
    const info = safe(() => engine.getInfo(), "") as string;
    const errors = safe(() => engine.getError(), [] as string[]) as string[];
    const combined = [
      ...liveLines.slice(linesBefore),
      info,
      ...errors,
      err instanceof Error ? err.message : String(err),
    ].join("\n");
    const diags = classifyStderr(combined);
    const errorDiag =
      diags.find((d) => d.severity === "error") ?? {
        code: "SIM-RUN-THREW",
        message: "The simulation run threw before producing a result.",
        hint: "See the raw output for the ngspice error.",
        severity: "error" as const,
        raw: err instanceof Error ? err.message : String(err),
      };
    return { ok: false, tables: [], transfer: [], errorDiag, linesBefore };
  }

  const info = safe(() => engine.getInfo(), "") as string;
  const errors = safe(() => engine.getError(), [] as string[]) as string[];

  // Classify only THIS rung's slice of the live stream so a prior rung's
  // singular-matrix line does not condemn a passing rung.
  const rungSlice = [...liveLines.slice(linesBefore), info, ...errors].join("\n");
  const diags = classifyStderr(rungSlice);
  const errorDiag = diags.find((d) => d.severity === "error") ?? null;

  const { tables, transfer } = toWaveTables(raw as never, probes);
  const hasData = tables.some((t) => t.values.length > 0);
  const ok = !errorDiag && hasData;
  return { ok, tables, transfer, errorDiag, linesBefore };
}

async function handleRun(id: string, netlist: string, probes?: ProbeSpec[]): Promise<void> {
  emit({ id, type: "progress", pct: 0, simTime: 0 });
  let engine: EEChip;
  try {
    engine = await getEngine();
  } catch (err) {
    emit({
      id,
      type: "error",
      diagnostic: {
        code: "SIM-ENGINE-LOAD-FAILED",
        message: "The WASM simulation engine failed to load.",
        hint: "Check the network/console; the WASM chunk may have failed to fetch.",
        severity: "error",
        raw: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  emit({ id, type: "progress", pct: 10, simTime: 0 });

  // Accumulate EVERY line ngspice prints during this run, wherever it comes from
  // (the live output callback + the post-run getInfo/getError). ngspice routes
  // some diagnostics (e.g. "Warning: singular matrix") through the live stream
  // and not always into getInfo(), so classifying only the post-run transcript
  // can miss them. We stream each line as it arrives (stderr never swallowed)
  // AND classify per rung at the end. Ladder note: the SLICE of liveLines
  // produced by rung N is what classifies rung N — a rung-2 singular-matrix
  // does NOT poison the rung-3 verdict, which must be free to succeed on its
  // own transcript (that is the whole point of the ladder).
  const liveLines: string[] = [];
  engine.setOutputEvent?.((out: string) => {
    for (const raw of String(out).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      liveLines.push(line);
      emit({ id, type: "stdout", line });
    }
  });

  // Walk the ladder (issue #94 / port of simulator.py:run_convergence_ladder).
  // Rung 1 is the as-written deck (byte-for-byte the pre-ladder single-run
  // behaviour); rungs 2..4 inject the manual-documented `.options` in the same
  // order and same tokens as the native ladder. First rung that converges wins.
  const ladderAttempts: SimLadderOutcome["attempts"] = [];
  let winningRung: LadderRung | null = null;
  let winningTables: ReturnType<typeof toWaveTables>["tables"] = [];
  let winningTransfer: ArrayBufferLike[] = [];
  let lastErrorDiag: import("./protocol").SimDiagnostic | null = null;

  for (const rung of CONVERGENCE_LADDER) {
    const rungNetlist = buildRungNetlist(netlist, rung);
    const outcome = await runRung(engine, rungNetlist, probes, liveLines);
    ladderAttempts.push({
      rung: rung.rung,
      name: rung.name,
      options: [...rung.options],
      converged: outcome.ok,
    });
    if (outcome.ok) {
      winningRung = rung;
      winningTables = outcome.tables;
      winningTransfer = outcome.transfer;
      lastErrorDiag = null;
      break;
    }
    lastErrorDiag = outcome.errorDiag;
    // Bounce progress a tick per non-converging rung so the UI shows movement.
    emit({ id, type: "progress", pct: 10 + rung.rung * 15, simTime: 0 });
  }

  emit({ id, type: "progress", pct: 90, simTime: 0 });

  // Stream the post-run transcript once (any error lines already went through
  // liveLines). This preserves the pre-ladder invariant that the client
  // receives the full ngspice info transcript exactly once per run.
  const info = safe(() => engine.getInfo(), "") as string;
  const errors = safe(() => engine.getError(), [] as string[]) as string[];
  streamOutput(id, info, errors);

  const ladder: SimLadderOutcome = {
    attempts: ladderAttempts,
    winningRung: winningRung ? winningRung.rung : null,
  };

  if (!winningRung) {
    // Ladder exhausted: every rung failed. Surface the last rung's error
    // diagnostic + the honest ladder record so the report pipeline marks the
    // convergence section `terminal: true`.
    const diagnostic = lastErrorDiag ?? {
      code: "SIM-UNKNOWN",
      message: "ngspice reported an error that is not yet mapped to a hint.",
      hint: "See the raw output. If this is common, add a rule in diagnostics.ts.",
      severity: "error" as const,
      raw: "",
    };
    emit({ id, type: "error", diagnostic, ladder });
    return;
  }

  emit({ id, type: "progress", pct: 100, simTime: 0 });
  emit(
    { id, type: "result", tables: winningTables, ladder },
    winningTransfer as unknown as Transferable[],
  );
}

function safe<T>(fn: () => T, fallback?: T): T | undefined {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

ctx.addEventListener("message", (ev: MessageEvent<WorkerInbound>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case "preload": {
      getEngine().then(
        () => post({ kind: "ready", id: msg.id, capabilities: capabilities() }),
        (err) =>
          post({
            kind: "fatal",
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          }),
      );
      break;
    }
    case "run": {
      void handleRun(msg.request.id, msg.request.netlist, msg.request.probes);
      break;
    }
    case "cancel": {
      // In-flight cancel is handled by the client terminating this worker (see
      // client.ts / ADR 0011). Reaching here means the run was idle/finished, so
      // acknowledge and stay usable.
      post({ kind: "canceled", id: msg.id });
      break;
    }
  }
});
