/**
 * sim-wasm wire protocol (issue #13).
 *
 * The typed message contract between the main-thread client (`SimClient`) and
 * the Web Worker that owns the WASM ngspice engine (`engine.worker.ts`). The
 * WASM engine NEVER touches the main thread (epic #12 binding decision 1;
 * AGENTS.md rule 8) -- this protocol is the ONLY way the UI talks to it.
 *
 * Design constraints baked in here:
 *
 *  - **Streaming.** A run yields a *sequence* of events (progress / stdout /
 *    stderr / result / error), not one batched promise, so the UI can render
 *    load progress, live logs, and per-line ngspice stderr as they happen. Every
 *    ngspice stderr line reaches the client as its own event -- stderr is NEVER
 *    swallowed (issue guardrail).
 *
 *  - **Transferable results.** Waveform samples travel as `Float64Array`s moved
 *    across the worker boundary via `Transferable`, not structured-cloned, so a
 *    100k-point transient does not copy megabytes onto the main thread.
 *
 *  - **Capabilities, forward-compatible.** The engine advertises a `capabilities`
 *    set. eecircuit-engine is fire-and-forget, so `control: false` today. A
 *    control-capable engine (halt/alter/resume, issue #88, gated before M8)
 *    slots in behind this SAME protocol later: it flips `control: true` and adds
 *    OPTIONAL `alter`/`halt`/`resume` control messages. Because control lives in
 *    a separate optional message channel (see `SimControl`), adding it is
 *    ADDITIVE -- existing `run`/`cancel`/`preload` consumers do not change, and
 *    M8 co-sim can feature-detect via `capabilities.control`. See ADR 0011.
 */

/** A probe: a signal to extract from the run and return as a wave table. */
export interface ProbeSpec {
  /** Stable id the caller uses to find this probe's table in the result. */
  id: string;
  /**
   * The ngspice vector name to extract, e.g. "v(mid)", "i(v1)", "time". Case is
   * preserved as given; matching against ngspice output is case-insensitive
   * (ngspice lower-cases node names). When omitted the engine returns ALL
   * vectors it produced (the /sim-lab raw-table use).
   */
  vector?: string;
}

/** A request to run one simulation. */
export interface SimRequest {
  /** Caller-chosen correlation id; every event for this run echoes it. */
  id: string;
  /** The ngspice netlist to simulate (as air-ts emits, #9). */
  netlist: string;
  /**
   * Optional probes to extract. Empty/omitted => return every vector ngspice
   * produced (the raw-table surface). Named probes filter+order the tables.
   */
  probes?: ProbeSpec[];
}

/**
 * One column of simulation output: a named signal and its samples. `values` is
 * a `Float64Array` (transferable). `unit` mirrors ngspice's vector type so the
 * report pipeline (#14) can format V / A / s without re-deriving it.
 */
export interface WaveTable {
  /** ngspice vector name, e.g. "time", "v(mid)", "i(v1)". */
  name: string;
  /** "time" | "voltage" | "current" | "frequency" | "notype". */
  unit: SignalUnit;
  /** Sample values, index-aligned with the sweep vector (usually "time"). */
  values: Float64Array;
}

export type SignalUnit =
  | "time"
  | "voltage"
  | "current"
  | "frequency"
  | "notype";

/**
 * Structured error surfaced to the client. `code` is a stable, matchable id
 * (see `diagnostics.ts`); `message` is the raw ngspice line(s) that triggered
 * it (never swallowed); `hint` is a human-readable next step. `raw` carries the
 * full captured stderr for debugging.
 */
export interface SimDiagnostic {
  /** Stable code, e.g. "SIM-SINGULAR-MATRIX". "SIM-UNKNOWN" if unclassified. */
  code: string;
  /** Short human-readable summary. */
  message: string;
  /** Actionable next step for the user, or "" when none is known. */
  hint: string;
  /** Severity; ngspice "Error" vs "Warning". Runs fail only on errors. */
  severity: "error" | "warning";
  /** The raw ngspice stderr line(s) this diagnostic was mapped from. */
  raw: string;
}

/**
 * Engine capability advertisement. Returned by `preload()` and carried on the
 * "ready" event. Additive by contract: new capability flags may be added; a
 * `false`/absent flag means "not supported by this engine build".
 */
export interface EngineCapabilities {
  /**
   * True iff the engine supports mid-transient halt/alter/resume driven from
   * the client (issue #88 / M8). `false` for eecircuit-engine (fire-and-forget,
   * ADR 0011). M8 co-sim MUST feature-detect on this before attempting control.
   */
  control: boolean;
  /** Underlying engine identifier, e.g. "eecircuit-engine". */
  engine: string;
  /** Engine package version, e.g. "1.7.0". */
  engineVersion: string;
  /** ngspice version the WASM was built from, e.g. "45.2". */
  ngspiceVersion: string;
}

/**
 * One rung attempt as surfaced to the client. Mirrors the browser ladder's
 * `LadderAttempt` shape (and the oracle's per-rung record in
 * simulator.py). The report pipeline (#14) turns this into the
 * ``convergence.attempts[]`` entries byte-for-byte.
 */
export interface SimLadderAttempt {
  rung: number;
  name: string;
  options: string[];
  converged: boolean;
}

/**
 * The convergence-ladder outcome for the run, carried alongside the terminal
 * `result`/`error` event so the report pipeline can build an honest
 * ``convergence`` section that reflects which rung succeeded (#94). Present on
 * every terminal event when the ladder was walked (i.e. the engine was
 * attempted). Byte-identical shape to the browser ladder's `LadderOutcome`.
 */
export interface SimLadderOutcome {
  attempts: SimLadderAttempt[];
  /** The rung index (1-based) that produced the result, or null on terminal. */
  winningRung: number | null;
}

/** Events streamed from the worker to the client for a single run. */
export type SimEvent =
  | { id: string; type: "progress"; pct: number; simTime: number }
  | { id: string; type: "stdout"; line: string }
  | { id: string; type: "stderr"; line: string }
  | { id: string; type: "result"; tables: WaveTable[]; ladder?: SimLadderOutcome }
  | { id: string; type: "error"; diagnostic: SimDiagnostic; ladder?: SimLadderOutcome };

/**
 * Worker-inbound messages. `run` and `cancel` are the core surface; `preload`
 * warms the WASM without running anything.
 *
 * FORWARD-COMPAT (issue #88): a control-capable engine will accept OPTIONAL
 * `halt` / `alter` / `resume` messages here. They are intentionally NOT part of
 * this union yet -- eecircuit cannot honor them -- but adding them is a pure
 * union extension: no existing message shape changes. `SimControl` documents
 * the reserved shape so #88 is a drop-in.
 */
export type WorkerInbound =
  | { kind: "preload"; id: string }
  | { kind: "run"; request: SimRequest }
  | { kind: "cancel"; id: string };

/** Worker-outbound messages: engine lifecycle + per-run events. */
export type WorkerOutbound =
  | { kind: "ready"; id: string; capabilities: EngineCapabilities }
  | { kind: "event"; event: SimEvent }
  | { kind: "canceled"; id: string }
  | { kind: "fatal"; id: string; message: string };

/**
 * RESERVED, not yet implemented (issue #88). The control message shape a
 * control-capable engine will accept. Documented here so the halt/alter/resume
 * engine is a drop-in behind the SAME protocol: the client gains a
 * `control(id, msg)` method, the worker union gains these variants, and
 * `capabilities.control` flips to true. Nothing in the current fire-and-forget
 * path references this type -- it is a contract placeholder only.
 */
export type SimControl =
  | { kind: "halt"; id: string; atSimTime: number }
  | { kind: "alter"; id: string; device: string; value: number }
  | { kind: "resume"; id: string };
