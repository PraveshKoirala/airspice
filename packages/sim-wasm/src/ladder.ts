/**
 * Browser-side convergence-aid ladder (issue #94, browser-port of issue #45).
 *
 * The Python oracle's ladder (packages/core/src/air/simulator.py:
 * ``CONVERGENCE_LADDER`` + ``run_convergence_ladder``) is the byte-for-byte
 * contract this module ports to the browser. The eecircuit engine has no
 * per-rung retry of its own: it runs the netlist AS-WRITTEN and either
 * converges or reports a singular-matrix / non-convergence stderr. Without a
 * browser ladder, a design that native ngspice solves via gmin/source-stepping
 * reports HONEST terminal non-convergence in the browser (see report.ts
 * DIVERGENCE B). This module closes that gap by injecting the SAME per-rung
 * ``.options`` the native ladder adds, in the SAME order, so a rung that
 * converges natively also converges in the browser.
 *
 * PORT DISCIPLINE (issue #94 guardrail):
 *   - The rungs, their ``.options`` tokens, and the order are byte-identical
 *     to simulator.py's ``CONVERGENCE_LADDER`` — same tuples, same order, same
 *     ``relaxes`` flag on rung 4. If simulator.py changes, this file must
 *     change with it (oracle-first).
 *   - Rung 1 is ALWAYS the netlist exactly as written (parity requirement):
 *     an already-converging design solves here and its measurements never
 *     change vs. a plain `prepareNetlist(netlist)` run.
 *   - ``.options`` are ADDED to the deck: the base netlist's own ``.options``
 *     are preserved (minus ``filetype=ascii`` which prepareNetlist already
 *     strips for eecircuit's binary rawfile reader).
 *
 * The ladder returns a `LadderOutcome` mirroring simulator.py's per-rung
 * attempts record; the browser report pipeline (air-ts report.ts) turns that
 * into the ``convergence`` section with `aids_required` / `rung` / `note` set
 * exactly the way `_convergence_section` does natively.
 */

import { prepareNetlist } from "./netlist";

/**
 * One rung of the browser ladder. Byte-identical to simulator.py `LadderRung`
 * (rung, name, options, relaxes).
 */
export interface LadderRung {
  rung: number;
  name: string;
  options: readonly string[];
  /**
   * True only on rung 4: the rung trades accuracy for convergence
   * (`method=gear` changes the integration rule, `reltol=0.005` loosens the
   * accuracy target). The report's note carries the "tolerance was relaxed"
   * disclosure when this rung wins — silent accuracy loss is what the ladder
   * exists to prevent.
   */
  relaxes: boolean;
}

/**
 * The fixed, deterministic ladder (max 4 rungs). PORTED VERBATIM from
 * simulator.py's ``CONVERGENCE_LADDER``. Rungs, names, option tokens, order,
 * and the `relaxes` flag on rung 4 must match the native tuple byte-for-byte;
 * changing one without the other breaks the browser/native contract.
 *
 * Manual citations for each rung's option tokens live in
 * docs/convergence_ladder.md; the tokens themselves are:
 *   Rung 1: ``()`` — as-written, no injected options.
 *   Rung 2: ``gminsteps=1 itl1=500`` — gmin stepping + more DC iterations.
 *   Rung 3: ``srcsteps=10 gminsteps=1 itl1=500`` — source stepping (compose).
 *   Rung 4: ``method=gear reltol=0.005 srcsteps=10 gminsteps=1 itl1=500
 *            itl4=100`` — Gear + one-notch relaxed reltol (`relaxes: true`).
 */
export const CONVERGENCE_LADDER: readonly LadderRung[] = [
  { rung: 1, name: "as-written", options: [], relaxes: false },
  { rung: 2, name: "gmin stepping", options: ["gminsteps=1", "itl1=500"], relaxes: false },
  {
    rung: 3,
    name: "source stepping",
    options: ["srcsteps=10", "gminsteps=1", "itl1=500"],
    relaxes: false,
  },
  {
    rung: 4,
    name: "Gear + relaxed reltol",
    options: [
      "method=gear",
      "reltol=0.005",
      "srcsteps=10",
      "gminsteps=1",
      "itl1=500",
      "itl4=100",
    ],
    relaxes: true,
  },
];

/** One rung's attempt record — mirrors simulator.py's attempts entry shape. */
export interface LadderAttempt {
  rung: number;
  name: string;
  options: string[];
  converged: boolean;
}

/**
 * The outcome of walking the ladder for one run. `winningRung` is the rung
 * that converged (its index in CONVERGENCE_LADDER), or `null` when every rung
 * failed (terminal). Mirrors simulator.py `LadderOutcome`.
 */
export interface LadderOutcome<T> {
  attempts: LadderAttempt[];
  /** The rung that produced `result`, or null on terminal exhaustion. */
  winningRung: LadderRung | null;
  /**
   * The winning rung's simulation result, or the LAST rung's result on
   * terminal exhaustion. `undefined` only when no rung ran (shouldn't happen
   * with a fixed 4-rung ladder, but kept for defensive typing).
   */
  result: T | undefined;
}

/**
 * Per-rung outcome the caller feeds back to the ladder driver. `converged`
 * decides whether the ladder stops (true) or climbs to the next rung (false).
 * `result` carries whatever the caller wants to hand back on success (e.g.
 * the eecircuit raw result); the driver returns the winning rung's `result`
 * (or the last rung's `result` on terminal exhaustion) to the caller.
 */
export interface RungOutcome<T> {
  converged: boolean;
  result: T;
}

/**
 * Build the effective netlist for one rung: `prepareNetlist(base)` PLUS the
 * rung's extra ``.options`` line prepended so the WASM engine picks it up
 * alongside the compiler's own options. `.options` lines COMPOSE in ngspice
 * (ADR: aids stack across rungs 2->3, rung 4 subsumes and relaxes), so
 * INJECTING a fresh ``.options`` line does not conflict with the base deck's
 * options — ngspice unions them.
 *
 * Rung 1's options tuple is empty; this function then simply returns
 * `prepareNetlist(base)` unchanged, guaranteeing an already-converging design
 * is solved on the exact same deck a rung-1-only browser would have run.
 */
export function buildRungNetlist(base: string, rung: LadderRung): string {
  const prepared = prepareNetlist(base);
  if (rung.options.length === 0) return prepared;
  const optionLine = `.options ${rung.options.join(" ")}`;
  // Insert the rung's .options line at the top of the netlist body. eecircuit
  // is whitespace-tolerant; a title-comment-first convention isn't enforced,
  // so a leading .options line is safe.
  return `${optionLine}\n${prepared}`;
}

/**
 * Walk the ladder, calling `runOne(netlist, rung)` for each rung until one
 * converges. Stops at the first rung that returns `converged: true`; returns
 * the winning rung + its `result`. If every rung fails, returns a terminal
 * outcome with `winningRung: null` and the LAST rung's `result` (so the
 * caller can still surface whatever the last attempt produced).
 *
 * The driver is transport-agnostic — it does NOT talk to eecircuit; the
 * caller decides how to run each rung's netlist (in the worker: post to the
 * engine + await runSim). This keeps the ladder logic pure and testable.
 *
 * PORT PARITY: mirrors simulator.py `run_convergence_ladder` — same order,
 * same "first rung that converges wins" stop rule, same terminal shape.
 */
export async function runConvergenceLadder<T>(
  base: string,
  runOne: (netlist: string, rung: LadderRung) => Promise<RungOutcome<T>>,
): Promise<LadderOutcome<T>> {
  const attempts: LadderAttempt[] = [];
  let winningRung: LadderRung | null = null;
  let lastResult: T | undefined;
  for (const rung of CONVERGENCE_LADDER) {
    const netlist = buildRungNetlist(base, rung);
    const outcome = await runOne(netlist, rung);
    attempts.push({
      rung: rung.rung,
      name: rung.name,
      options: [...rung.options],
      converged: outcome.converged,
    });
    lastResult = outcome.result;
    if (outcome.converged) {
      winningRung = rung;
      break;
    }
  }
  return { attempts, winningRung, result: lastResult };
}
