/**
 * Build-benchmark EngineHooks (issue #107).
 *
 * The build loop drives the agent through the #18 ToolRuntime, which consumes the
 * engine via the EngineHooks seam. As in #19's bench engine, the gate functions
 * (normalize → validate → applyPatch → previewPatch → registry) are the REAL
 * air-ts functions injected as a facade — the SAME gate that runs in production —
 * so every `set_design` the agent makes is gated by the real validator.
 *
 * The `simulate` hook is the ONE part that differs by mode. It backs the AGENT'S
 * own `run_simulation` tool (its iterative feedback while building), NOT the
 * objective score — a build passes on the Python scorer's real-ngspice
 * sim_assertion (scorer.ts), independent of anything run_simulation returns.
 *
 *   - MOCK (CI): a deterministic simulate — a design that validates clean reports
 *     `passed` with the #14 shape. No ngspice, no network; CI-safe.
 *   - LIVE: a real-ngspice simulate via the `air.build_sim_cli` subprocess, so the
 *     agent tunes analog values against real physics as it builds.
 *
 * The air-ts facade is INJECTED (not imported here) so the SAME engine module
 * serves the CI vitest test (aliased air-ts) and the CLI (relative air-ts).
 */

import { spawn } from "node:child_process";
import type {
  EngineHooks,
  GateDiagnostic,
  PatchPreviewResult,
  SimulationReportLike,
} from "../../src/index.js";

/** The subset of the air-ts facade the build engine needs (injected). */
export interface AirTsFacade {
  normalize(xml: string): string;
  validate(xml: string): Array<{ severity: string; code: string; message: string; related_elements?: string[]; [k: string]: unknown }>;
  applyPatch(designXml: string, patchXml: string): string;
  previewPatch(
    designXml: string,
    patchXml: string,
  ): {
    success: boolean;
    operations: unknown[];
    resolved: string[];
    introduced: string[];
    before: { errors: number; warnings: number };
    after: { errors: number; warnings: number };
  };
  COMPONENT_SPECS: Record<string, unknown>;
  MCUS: Record<string, unknown>;
}

export interface BuildEngineOptions {
  /** "mock" → deterministic sim; "live" → real ngspice via subprocess. */
  mode: "mock" | "live";
  /** Absolute repo root (for the live sim subprocess PYTHONPATH). */
  repoRoot: string;
  /** Python executable for the live sim subprocess. Defaults to `python`. */
  pythonBin?: string;
  /** Live sim subprocess timeout (ms). */
  simTimeoutMs?: number;
}

/** Build the build-benchmark EngineHooks from an injected air-ts facade. */
export function buildEngine(air: AirTsFacade, opts: BuildEngineOptions): EngineHooks {
  const gate = {
    normalize: (xml: string) => air.normalize(xml),
    validate: (xml: string) => air.validate(xml) as unknown as GateDiagnostic[],
    applyPatch: (design: string, patch: string) => air.applyPatch(design, patch),
    previewPatch: (design: string, patch: string) => {
      const p = air.previewPatch(design, patch);
      return {
        success: p.success,
        operations: p.operations,
        resolved: p.resolved,
        introduced: p.introduced,
        before: { errors: p.before.errors, warnings: p.before.warnings },
        after: { errors: p.after.errors, warnings: p.after.warnings },
      } satisfies PatchPreviewResult;
    },
    listRegistry: () => ({
      components: Object.keys(air.COMPONENT_SPECS).sort(),
      mcus: Object.keys(air.MCUS).sort(),
    }),
    readWaveform: () => null,
  };

  const simulate =
    opts.mode === "live"
      ? liveSimulate(opts.repoRoot, opts.pythonBin ?? "python", opts.simTimeoutMs ?? 60_000, air)
      : mockSimulate(air);

  return { ...gate, simulate };
}

/**
 * MOCK simulate: a validated design reports `passed` in the #14 shape. The agent's
 * run_simulation in CI is deterministic and offline (the mock provider never
 * relies on it anyway — the scripted build stages a known-good design).
 */
function mockSimulate(air: AirTsFacade): EngineHooks["simulate"] {
  return async (xml, signal) => {
    if (signal.aborted) throw new Error("aborted");
    const errors = air.validate(xml).filter((d) => d.severity === "error");
    const passed = errors.length === 0;
    return {
      profile: "analog_only",
      status: passed ? "passed" : "failed",
      reports: [
        {
          test: "bench",
          profile: "analog_only",
          status: passed ? "passed" : "failed",
          backend: "builtin_dc_fallback",
          convergence: {
            attempts: [{ rung: 1, name: "as-written", options: [], converged: passed }],
            converged: passed,
            rung: passed ? 1 : null,
            aids_required: false,
            terminal: false,
            note: null,
          },
          measurements: {},
          diagnostics: [],
        },
      ],
      notes: [],
      runId: "build-mock-run",
    } satisfies SimulationReportLike;
  };
}

/**
 * LIVE simulate: run the design through real ngspice via `air.build_sim_cli`, so
 * the agent gets true physics feedback while building. A subprocess failure
 * degrades gracefully to a `failed` report (the agent sees the design didn't
 * simulate) — it never throws into the loop, which would abort the build.
 */
function liveSimulate(
  repoRoot: string,
  pythonBin: string,
  timeoutMs: number,
  air: AirTsFacade,
): EngineHooks["simulate"] {
  return async (xml, signal) => {
    // Do not even attempt a live sim on a design that does not validate — mirror
    // the loop discipline (validation gates simulation) and save a subprocess.
    const errors = air.validate(xml).filter((d) => d.severity === "error");
    if (errors.length > 0) {
      return failedReport("design did not validate; skipped simulation");
    }
    try {
      return await runSimSubprocess(xml, repoRoot, pythonBin, timeoutMs, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      return failedReport(`simulation subprocess error: ${(err as Error).message.slice(0, 160)}`);
    }
  };
}

function failedReport(note: string): SimulationReportLike {
  return {
    profile: "analog_only",
    status: "failed",
    reports: [],
    notes: [note],
    runId: "build-sim",
  };
}

function runSimSubprocess(
  designXml: string,
  repoRoot: string,
  pythonBin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SimulationReportLike> {
  return new Promise<SimulationReportLike>((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: `${repoRoot}/packages/core/src` };
    const child = spawn(pythonBin, ["-m", "air.build_sim_cli"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      done(() => reject(new Error("aborted")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(() => reject(new Error(`sim subprocess timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => done(() => reject(err)));
    child.on("close", (code) => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        done(() => reject(new Error(`sim produced no output (exit ${code}). stderr: ${stderr.slice(0, 300)}`)));
        return;
      }
      try {
        done(() => resolve(JSON.parse(trimmed) as SimulationReportLike));
      } catch (err) {
        done(() => reject(new Error(`sim output not JSON: ${(err as Error).message}`)));
      }
    });
    child.stdin.write(JSON.stringify({ design_xml: designXml }));
    child.stdin.end();
  });
}
