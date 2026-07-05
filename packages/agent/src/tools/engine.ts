/**
 * The engine seam: the air-ts / sim-wasm operations the tool runtime consumes
 * (issue #18: "CONSUME air-ts validate/normalize/patch/emit and the sim report
 * pipeline; don't rewrite their logic").
 *
 * WHY AN INTERFACE (dependency inversion, not indirection-for-its-own-sake):
 *   - packages/agent must stay browser-safe and its CI job must run without a
 *     DOM or a WASM worker. Threading the engine operations through this seam
 *     lets the pure tool runtime live here, while the concrete wiring (real
 *     air-ts functions; the sim-wasm-backed simulate) is supplied by the UI.
 *   - The gate (`gateDesign`) depends on `normalize`/`validate` through this
 *     seam, so the SAME gate code runs in production (real air-ts) and in this
 *     package's CI (real air-ts, imported via the vitest/tsconfig alias). The
 *     invariant is therefore tested against the real validator, not a stub.
 *
 * Every method is a thin pass-through to an air-ts (or sim-wasm-report) export;
 * shapes mirror the air-ts facade so the UI's adapter is a one-liner per method.
 */

/**
 * A validation diagnostic — the shape air-ts's `validate()` returns (a subset of
 * air-ts `Diagnostic`; extra fields are ignored). `severity: "error"` is the
 * gate's pass/fail signal.
 */
export interface GateDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  domain?: string;
  related_elements?: string[];
  [k: string]: unknown;
}

/** The structured op diff air-ts `previewPatch` returns (subset we surface). */
export interface PatchPreviewResult {
  success: boolean;
  operations: unknown[];
  /** Diagnostic-code keys the patch RESOLVED (present-before, absent-after). */
  resolved: string[];
  /** Diagnostic-code keys the patch INTRODUCED (absent-before, present-after). */
  introduced: string[];
  before: { errors: number; warnings: number };
  after: { errors: number; warnings: number };
}

/** A decimated waveform summary for `read_waveform` (never raw 100k samples). */
export interface WaveformSummary {
  net: string;
  test: string;
  /** Total samples the engine produced before decimation. */
  totalPoints: number;
  /** The number of points actually returned (<= the tool's max N). */
  returnedPoints: number;
  /** Decimated `[time_s, value]` points, at most `maxPoints`. */
  points: Array<[number, number]>;
  /** Convenience scalars so the model needn't scan the point list. */
  final: number;
  min: number;
  max: number;
  unit: string;
}

/** The report object air-ts `buildReport` produces (schema from #14). */
export interface SimulationReportLike {
  profile: string;
  status: "passed" | "failed";
  reports: unknown[];
  /** Per-test notes (stderr SUMMARIES, not dumps) the runtime caps + surfaces. */
  notes?: string[];
  /** The waveform run id, for a subsequent read_waveform call. */
  runId?: string;
}

/** The registry listing (from air-ts's compiled registry, #8). */
export interface RegistryListing {
  components: string[];
  mcus: string[];
}

/**
 * The operations the tool runtime needs from the engine. Implemented in the UI
 * by delegating to the air-ts facade + the sim-wasm-backed local pipeline; in
 * CI by importing air-ts directly (real gate) plus a deterministic simulate.
 */
export interface EngineHooks {
  /** air-ts `normalize(xml)` -> canonical normalized XML. Throws on malformed. */
  normalize(xml: string): string;
  /** air-ts `validate(xml)` -> ordered diagnostics (empty === clean). */
  validate(xml: string): GateDiagnostic[];
  /** air-ts `applyPatch(design, patch)` -> canonical patched XML. */
  applyPatch(designXml: string, patchXml: string): string;
  /** air-ts `previewPatch(design, patch)` -> structured diff + deltas. */
  previewPatch(designXml: string, patchXml: string): PatchPreviewResult;
  /** air-ts registry listing (COMPONENT_SPECS / MCUS keys). */
  listRegistry(): RegistryListing;
  /**
   * Run the design's default ngspice profile and return the oracle-schema
   * report (#14). `signal` aborts an in-flight run (the Stop button cancels the
   * simulation via sim-wasm's terminate-and-respawn, ADR 0011). Rejects if
   * aborted or if the design has no ngspice profile.
   */
  simulate(xml: string, signal: AbortSignal): Promise<SimulationReportLike>;
  /**
   * Read a DECIMATED waveform summary for a probed net from a prior run. Returns
   * null when the run/net is unknown. `maxPoints` caps the returned points.
   */
  readWaveform(runId: string, net: string, maxPoints: number): WaveformSummary | null;
}
