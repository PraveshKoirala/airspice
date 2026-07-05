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
  WorkerInbound,
  WorkerOutbound,
} from "./protocol";
import { classifyStderr } from "./diagnostics";
import { toWaveTables } from "./result";
import { prepareNetlist } from "./netlist";

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
  // AND classify the union at the end.
  const liveLines: string[] = [];
  engine.setOutputEvent?.((out: string) => {
    for (const raw of String(out).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      liveLines.push(line);
      emit({ id, type: "stdout", line });
    }
  });

  let raw: unknown;
  try {
    // Adapt the emitted netlist for the WASM engine (strip host-only .control
    // blocks + ascii-rawfile option; devices/analysis untouched). See netlist.ts.
    engine.setNetList(prepareNetlist(netlist));
    raw = await engine.runSim();
  } catch (err) {
    // A throw from runSim is an engine-level failure; classify what we captured.
    const info = safe(() => engine.getInfo(), "") as string;
    const errors = safe(() => engine.getError(), [] as string[]) as string[];
    streamOutput(id, info, errors);
    const combined = [...liveLines, info, ...errors, err instanceof Error ? err.message : String(err)].join("\n");
    const diags = classifyStderr(combined);
    emit({
      id,
      type: "error",
      diagnostic: diags[0] ?? {
        code: "SIM-RUN-THREW",
        message: "The simulation run threw before producing a result.",
        hint: "See the raw output for the ngspice error.",
        severity: "error",
        raw: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  emit({ id, type: "progress", pct: 90, simTime: 0 });

  // Stream the post-run transcript + any error lines (stderr never swallowed).
  const info = safe(() => engine.getInfo(), "") as string;
  const errors = safe(() => engine.getError(), [] as string[]) as string[];
  streamOutput(id, info, errors);

  // Did ngspice flag a real failure? Classify the UNION of everything printed.
  const diags = classifyStderr([...liveLines, info, ...errors].join("\n"));
  const errorDiag = diags.find((d) => d.severity === "error");
  if (errorDiag) {
    emit({ id, type: "error", diagnostic: errorDiag });
    return;
  }

  // Convert to transferable wave tables and hand back the result.
  const { tables, transfer } = toWaveTables(raw as never, probes);
  emit({ id, type: "progress", pct: 100, simTime: 0 });
  emit({ id, type: "result", tables }, transfer as unknown as Transferable[]);
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
