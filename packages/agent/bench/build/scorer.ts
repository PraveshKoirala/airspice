/**
 * The objective build scorer (issue #107 deliverable 2) — a THIN TS wrapper over
 * #106's Python predicate solver + real-ngspice sim (`air.build_score`).
 *
 * DECISION (issue #107 "call the Python scorer OR port it to TS"): CALL IT. The
 * scorer #106 built and verified against every golden is the Python constraint
 * solver `evaluate_connectivity` + `check_required_components` +
 * `check_firmware_intent` + a REAL ngspice `sim_assertion`. Re-implementing that
 * — especially the physics — in TS would risk divergence from the code #106
 * proved discriminates (a golden PASSES, a broken design FAILS the right
 * criterion). Instead the harness invokes `python -m air.build_score_cli` as a
 * subprocess: it writes `{design_xml, criteria}` on stdin and reads the score on
 * stdout. The SAME code that `tests/test_build_specs.py` runs scores the agent's
 * build — no weakening, no fork.
 *
 * The scorer is OBJECTIVE code, never an LLM judge (issue #107 cardinal rule):
 * a build passes because the MODEL satisfied the criteria, checked
 * deterministically on the parsed net/pin graph + ERC + real physics.
 */

import { spawn } from "node:child_process";
import type { BuildCriteria } from "./specs.js";

/** The scorer's verdict on one built design against one spec's criteria. */
export interface BuildScore {
  /** True iff the design passed EVERY criterion — the definition of "built". */
  readonly built: boolean;
  /** The first criterion that failed (null on a build). For the results table. */
  readonly failed_criterion: string | null;
  /** Human-readable reason for the failure (empty on a build). */
  readonly detail: string;
  /** Per-criterion pass/fail (for the per-spec row). */
  readonly criteria: Record<string, boolean>;
  /** The sim backend used, if a sim_assertion ran ("ngspice" or a fallback). */
  readonly sim_backend: string | null;
  /** The measured net voltage, if a sim_assertion ran. */
  readonly sim_value: number | null;
}

export interface ScoreBuildOptions {
  /** Absolute repo root (to set PYTHONPATH=packages/core/src). */
  repoRoot: string;
  /** The python executable to invoke. Defaults to `python`. */
  pythonBin?: string;
  /** Timeout for the scorer subprocess (ms). Real ngspice is fast; default 60s. */
  timeoutMs?: number;
}

/**
 * A scorer function: score a built design against a spec's criteria. The default
 * is the Python subprocess (`subprocessScorer`); the CI mock test injects a
 * deterministic one so the harness mechanics run OFFLINE (Node-only CI, no
 * python/ngspice) while the REAL scorer is validated separately against every
 * golden by `tests/test_build_specs.py` (the Python CI). Injecting the scorer is
 * NOT weakening it — CI proves harness+integration mechanics; the Python suite
 * proves the objective scorer discriminates.
 */
export type ScoreFn = (designXml: string, criteria: BuildCriteria) => Promise<BuildScore>;

/** The default scorer: bind `scoreBuild` to a set of subprocess options. */
export function subprocessScorer(opts: ScoreBuildOptions): ScoreFn {
  return (designXml, criteria) => scoreBuild(designXml, criteria, opts);
}

/**
 * Score a built design against a spec's criteria via the Python scorer subprocess.
 *
 * Rejects (rather than returning a false "not built") on a scorer INFRASTRUCTURE
 * failure — a missing python, an import error, a subprocess crash — so the harness
 * records `scorer_error` distinctly and never mislabels a broken toolchain as an
 * agent failure. A design that the scorer evaluates and finds wanting returns a
 * `built: false` with the failing criterion; THAT is an honest agent failure.
 */
export function scoreBuild(
  designXml: string,
  criteria: BuildCriteria,
  opts: ScoreBuildOptions,
): Promise<BuildScore> {
  const python = opts.pythonBin ?? "python";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const request = JSON.stringify({ design_xml: designXml, criteria });

  return new Promise<BuildScore>((resolve, reject) => {
    const env = {
      ...process.env,
      // The scorer imports `air.*`; PYTHONPATH points at the core package src.
      PYTHONPATH: `${opts.repoRoot}/packages/core/src`,
    };
    const child = spawn(python, ["-m", "air.build_score_cli"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`scorer subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`scorer subprocess failed to start (${python}): ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(
          new Error(
            `scorer subprocess produced no output (exit ${code}). stderr: ${stderr.slice(0, 600)}`,
          ),
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        reject(
          new Error(
            `scorer subprocess output was not JSON (exit ${code}): ${(err as Error).message}. ` +
              `stdout: ${trimmed.slice(0, 300)} stderr: ${stderr.slice(0, 300)}`,
          ),
        );
        return;
      }
      const score = parsed as BuildScore;
      // A `request`-level failure (bad JSON in / malformed criteria) is a harness
      // bug, not an agent failure — surface it as a scorer error.
      if (score.failed_criterion === "request") {
        reject(new Error(`scorer rejected the request: ${score.detail}`));
        return;
      }
      resolve(score);
    });

    child.stdin.write(request);
    child.stdin.end();
  });
}
