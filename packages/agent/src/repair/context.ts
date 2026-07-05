/**
 * Repair-context assembly + the semantic convergence primitives (issue #19).
 *
 * PORT of the Python repair-context design (`repair.py:build_repair_context`
 * plus the report-diagnostics merge `auto_repair.py` reads): the model that
 * proposes a fix is handed the failing assertions, the validation diagnostics,
 * and the RELEVANT design/report excerpts. Two binding amendments live here:
 *
 *   - FRESH CONTEXT PER ITERATION (amendment 1). `assembleRepairContext` builds
 *     the whole per-iteration user message from scratch: current design + fresh
 *     repair-context + a COMPACT structured history (patch summary + prior
 *     diagnostic codes, never full patches/reports). It enforces a HARD char
 *     budget — exceeding it THROWS (`assertBudget`), because a growing context
 *     is a bug, not a truncation event. Excerpts are DECIMATED per #18's tool
 *     hygiene (netlist head, a handful of failing diagnostics, waveform scalars)
 *     so the assembled size is bounded by construction.
 *
 *   - SEMANTIC NO-PROGRESS (amendment 2). `diagnosticSignature` reduces an
 *     evaluation to its SEMANTIC essence — the sorted diagnostic-code SET plus
 *     the assertion pass/fail VECTOR — and `signaturesEqual` compares two of
 *     them. This is what the loop's no-progress detector uses; it is deliberately
 *     blind to floats/timestamps (two reports differing only in numeric noise
 *     have the SAME signature).
 *
 *   - CONVERGENCE AWARENESS (#45, amendment 3). `evaluateDesign` reads the #14
 *     report's `convergence` section: a design whose sim PASSED is `passes:true`
 *     regardless of the ladder rung it converged on (a rung >= 2 success is not a
 *     defect). A TERMINAL convergence failure sets `topologyFirst`, and the
 *     assembled context surfaces the topology-first hint (floating nodes /
 *     missing ground) BEFORE any value-change guidance.
 */

import type { EngineHooks, GateDiagnostic, SimulationReportLike } from "../tools/engine.js";
import { capString } from "../tools/truncate.js";

// --------------------------------------------------------------------------- //
// The semantic diagnostic signature (amendment 2).
// --------------------------------------------------------------------------- //

/**
 * The SEMANTIC essence of an evaluation, for no-progress detection. Two rounds
 * with the same signature are "no progress" even if their reports differ in
 * floats/timestamps. Comparison is over:
 *   - `codes`: the SORTED, de-duplicated set of diagnostic codes (validation +
 *     report diagnostics). Order-independent, value-independent.
 *   - `assertionVector`: the assertion pass/fail VECTOR — one entry per assertion
 *     subject, sorted by subject, recording pass/fail. This distinguishes "same
 *     codes, different assertions failing" from true stasis.
 */
export interface DiagnosticSignature {
  /** Sorted, de-duplicated diagnostic codes (validation + report). */
  readonly codes: readonly string[];
  /** Sorted `subject=pass|fail` assertion-outcome pairs. */
  readonly assertionVector: readonly string[];
}

/**
 * Reduce diagnostics + report to a semantic signature. The `codes` set unions
 * validation diagnostics and every report's diagnostics; the assertion vector
 * records each assertion subject's pass/fail (a report diagnostic with an
 * `ASSERT_FAILED` / `ASSERT_NO_MEASUREMENT` code names its subject in
 * `related_elements` — the SUBJECT, not the value, is what matters).
 */
export function diagnosticSignature(
  validationDiagnostics: readonly GateDiagnostic[],
  report: SimulationReportLike | null,
): DiagnosticSignature {
  const codes = new Set<string>();
  for (const d of validationDiagnostics) {
    if (d.severity === "error" && d.code) codes.add(d.code);
  }
  const assertionOutcomes = new Map<string, boolean>(); // subject -> passed

  if (report) {
    for (const r of report.reports) {
      const rep = r as ReportEntry;
      const reportDiags = Array.isArray(rep.diagnostics) ? rep.diagnostics : [];
      for (const d of reportDiags) {
        if (d && typeof d.code === "string") {
          codes.add(d.code);
          if (d.code === "ASSERT_FAILED" || d.code === "ASSERT_NO_MEASUREMENT") {
            const subject = assertionSubject(d);
            if (subject) assertionOutcomes.set(subject, false);
          }
        }
      }
      // An assertion subject with no failing diagnostic is a PASS. We can only
      // enumerate subjects the report failed; that is sufficient for the vector
      // (a subject flipping from fail->pass changes the vector => progress).
    }
  }

  const assertionVector = [...assertionOutcomes.entries()]
    .map(([subject, passed]) => `${subject}=${passed ? "pass" : "fail"}`)
    .sort();

  return {
    codes: [...codes].sort(),
    assertionVector,
  };
}

/** Structural equality of two semantic signatures (amendment 2). */
export function signaturesEqual(a: DiagnosticSignature, b: DiagnosticSignature): boolean {
  return arrayEqual(a.codes, b.codes) && arrayEqual(a.assertionVector, b.assertionVector);
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --------------------------------------------------------------------------- //
// Design evaluation: validate + simulate + read the #45 convergence section.
// --------------------------------------------------------------------------- //

/** Minimal shape of one #14 report entry this module reads (open for extras). */
interface ReportEntry {
  test?: string;
  status?: "passed" | "failed";
  diagnostics?: Array<{ code?: string; message?: string; related_elements?: string[]; severity?: string }>;
  convergence?: {
    terminal?: boolean;
    converged?: boolean;
    rung?: number | null;
    note?: string | null;
  };
  measurements?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The outcome of diagnosing the current design — what an iteration reasons on. */
export interface DesignEvaluation {
  /** The design XML that was evaluated. */
  readonly designXml: string;
  /** True when validation is error-clean AND the simulation PASSED (#45-aware). */
  readonly passes: boolean;
  /** Error-severity validation diagnostics (empty === structurally valid). */
  readonly validationErrors: readonly GateDiagnostic[];
  /** All validation diagnostics (errors + warnings + info). */
  readonly validationDiagnostics: readonly GateDiagnostic[];
  /** The #14 simulation report, or null if the design did not even validate. */
  readonly report: SimulationReportLike | null;
  /** Failing-assertion messages pulled from the report (for the context body). */
  readonly failingAssertions: readonly string[];
  /**
   * TERMINAL convergence failure (#45): the engine ran but did not converge, and
   * there is no ladder rung to climb — a TOPOLOGY problem (floating node /
   * missing ground) before a value problem. Drives the topology-first hint.
   */
  readonly topologyFirst: boolean;
  /** The convergence note the report surfaced, if terminal. */
  readonly convergenceNote: string | null;
  /** The semantic signature for no-progress detection (amendment 2). */
  readonly signature: DiagnosticSignature;
}

/**
 * Diagnose the current design: run the validation gate's `validate`, then (only
 * if it validates) `simulate`. Returns everything an iteration needs.
 *
 * #45 CONVERGENCE AWARENESS: `passes` is true iff validation is error-clean AND
 * every report's status is "passed" — a passing sim is not a defect regardless
 * of the rung it converged on. A report whose `convergence.terminal` is true
 * (engine ran, never converged) sets `topologyFirst`, steering diagnosis to
 * topology before values.
 */
export async function evaluateDesign(
  designXml: string,
  hooks: EngineHooks,
  signal: AbortSignal,
): Promise<DesignEvaluation> {
  const validationDiagnostics = safeValidate(hooks, designXml);
  const validationErrors = validationDiagnostics.filter((d) => d.severity === "error");

  let report: SimulationReportLike | null = null;
  // Only simulate a design that structurally validates — an invalid design has
  // no meaningful sim (mirrors the Python loop: validation gates simulation).
  if (validationErrors.length === 0) {
    try {
      report = await hooks.simulate(designXml, signal);
    } catch (err) {
      // A simulate failure (no ngspice profile, engine error) leaves report null;
      // the design is treated as not-yet-passing. An abort re-throws upward.
      if (signal.aborted) throw err;
      report = null;
    }
  }

  const failingAssertions = report ? collectFailingAssertions(report) : [];
  const { topologyFirst, convergenceNote } = readConvergence(report);
  const signature = diagnosticSignature(validationDiagnostics, report);

  const simPassed = report !== null && report.status === "passed";
  const passes = validationErrors.length === 0 && simPassed;

  return {
    designXml,
    passes,
    validationErrors,
    validationDiagnostics,
    report,
    failingAssertions,
    topologyFirst,
    convergenceNote,
    signature,
  };
}

/** validate() but never throws — malformed XML yields a single parse error. */
function safeValidate(hooks: EngineHooks, xml: string): GateDiagnostic[] {
  try {
    return hooks.validate(xml);
  } catch (err) {
    return [
      {
        severity: "error",
        code: "XML_PARSE_ERROR",
        message: (err as Error).message,
        domain: "structure",
        related_elements: [],
      },
    ];
  }
}

/** Pull human failing-assertion lines from a report's failed test diagnostics. */
function collectFailingAssertions(report: SimulationReportLike): string[] {
  const out: string[] = [];
  for (const r of report.reports) {
    const rep = r as ReportEntry;
    const diags = Array.isArray(rep.diagnostics) ? rep.diagnostics : [];
    for (const d of diags) {
      if (d && (d.code === "ASSERT_FAILED" || d.code === "ASSERT_NO_MEASUREMENT")) {
        const subject = assertionSubject(d) ?? "(unknown)";
        out.push(`${rep.test ?? "test"}: ${d.code} on ${subject}${d.message ? ` — ${d.message}` : ""}`);
      }
    }
  }
  return out;
}

/** The assertion subject a report diagnostic names (related_elements tail). */
function assertionSubject(d: { related_elements?: string[] }): string | null {
  const els = d.related_elements;
  if (Array.isArray(els) && els.length > 0) {
    // related_elements is [test_id, subject]; the subject is the meaningful one.
    return els[els.length - 1] ?? null;
  }
  return null;
}

/** Read the #45 convergence section: terminal failure => topology-first. */
function readConvergence(report: SimulationReportLike | null): {
  topologyFirst: boolean;
  convergenceNote: string | null;
} {
  if (!report) return { topologyFirst: false, convergenceNote: null };
  for (const r of report.reports) {
    const conv = (r as ReportEntry).convergence;
    if (conv && conv.terminal === true) {
      return { topologyFirst: true, convergenceNote: conv.note ?? null };
    }
  }
  return { topologyFirst: false, convergenceNote: null };
}

// --------------------------------------------------------------------------- //
// Fresh per-iteration context assembly (amendment 1) — under a HARD budget.
// --------------------------------------------------------------------------- //

/** Everything the per-iteration context is assembled from (rebuilt each round). */
export interface RepairContextInput {
  /** The CURRENT design XML this round diagnoses + patches. */
  designXml: string;
  /** The diagnosis of the current design (validate + simulate). */
  evaluation: DesignEvaluation;
  /** COMPACT prior-attempt history: summaries + prior codes, not full patches. */
  history: ReadonlyArray<{ iteration: number; patchSummary: string; resolvedCodes: readonly string[] }>;
  /** 0-based iteration index. */
  iteration: number;
  /** The iteration cap (surfaced so the model knows its remaining budget). */
  maxIterations: number;
}

/**
 * Assemble the FRESH per-iteration user message (amendment 1). Each section is
 * DECIMATED (design head, a handful of failing diagnostics, waveform scalars,
 * compact history) so the total is bounded by construction. The assembled string
 * MUST fit `charBudget`; if it would exceed it, `assertBudget` THROWS — a
 * growing context is a bug, not a truncation event.
 *
 * Ordering deliberately follows #45's convergence awareness: when the sim
 * failed TERMINALLY on convergence, the TOPOLOGY-first hint comes BEFORE the
 * failing-assertion / value guidance.
 */
export function assembleRepairContext(input: RepairContextInput, charBudget: number): string {
  const { evaluation } = input;
  const parts: string[] = [];

  parts.push(
    `You are on repair iteration ${input.iteration + 1} of at most ${input.maxIterations}. ` +
      "Diagnose the design below and propose the SMALLEST patch that makes it validate and pass its tests.",
  );

  // #45: terminal convergence => topology BEFORE values (amendment 3).
  if (evaluation.topologyFirst) {
    parts.push(
      "CONVERGENCE (topology first): the simulation ran but did NOT converge. " +
        "This is almost always a TOPOLOGY problem — a floating node or a missing DC " +
        "path to ground — NOT a component-value problem. Inspect the topology " +
        "(every net's connection to ground, no dangling pins) BEFORE changing any values." +
        (evaluation.convergenceNote ? `\nEngine note: ${evaluation.convergenceNote}` : ""),
    );
  }

  // Validation diagnostics (decimated to the errors, capped list).
  if (evaluation.validationErrors.length > 0) {
    const shown = evaluation.validationErrors.slice(0, MAX_DIAGNOSTICS);
    const lines = shown.map(
      (d) => `- [${d.code}] ${d.message}${relatedSuffix(d.related_elements)}`,
    );
    const more = evaluation.validationErrors.length - shown.length;
    parts.push(
      `VALIDATION ERRORS (${evaluation.validationErrors.length}):\n` +
        lines.join("\n") +
        (more > 0 ? `\n(+${more} more)` : ""),
    );
  }

  // Failing assertions from the sim report (decimated).
  if (evaluation.failingAssertions.length > 0) {
    const shown = evaluation.failingAssertions.slice(0, MAX_DIAGNOSTICS);
    const more = evaluation.failingAssertions.length - shown.length;
    parts.push(
      `FAILING ASSERTIONS (${evaluation.failingAssertions.length}):\n` +
        shown.map((a) => `- ${a}`).join("\n") +
        (more > 0 ? `\n(+${more} more)` : ""),
    );
  }

  // Report measurement excerpt (decimated scalars, never the raw waveform).
  const measExcerpt = measurementExcerpt(evaluation.report);
  if (measExcerpt) parts.push(`MEASUREMENTS (excerpt):\n${measExcerpt}`);

  // COMPACT prior-attempt history (summaries only — NOT full patches/reports).
  if (input.history.length > 0) {
    const lines = input.history
      .slice(-MAX_HISTORY)
      .map(
        (h) =>
          `- iter ${h.iteration + 1}: ${h.patchSummary} (then-diagnostics: ${
            h.resolvedCodes.length ? h.resolvedCodes.join(", ") : "none"
          })`,
      );
    parts.push(
      "PRIOR ATTEMPTS (compact — do NOT repeat a patch that did not help):\n" + lines.join("\n"),
    );
  }

  // The current design — the ONE large section; decimated with a HEAD budget so
  // the whole message stays under the hard budget. (The model can call
  // get_design for the full text if it truly needs it.)
  const reserved = parts.join("\n\n").length + DESIGN_HEADER.length + BUDGET_SLACK;
  const designBudget = Math.max(MIN_DESIGN_CHARS, charBudget - reserved);
  const designText = capString(input.designXml, designBudget);
  parts.push(DESIGN_HEADER + designText);

  const assembled = parts.join("\n\n");
  assertBudget(assembled, charBudget);
  return assembled;
}

const DESIGN_HEADER = "CURRENT DESIGN (AIR XML):\n";
/** Max diagnostics/assertions listed per section (decimation). */
const MAX_DIAGNOSTICS = 12;
/** Max prior attempts surfaced (the most recent). */
const MAX_HISTORY = 6;
/** Max measurement scalars surfaced from a report. */
const MAX_MEASUREMENTS = 16;
/** Floor for the design excerpt so the model always sees the design shape. */
const MIN_DESIGN_CHARS = 400;
/** Slack so the design-budget subtraction never overshoots the hard cap. */
const BUDGET_SLACK = 64;

/**
 * The HARD budget assertion (amendment 1). Assembling a context beyond the
 * budget is a BUG — the loop must not silently truncate its own reasoning
 * surface — so this THROWS. The loop's default budget is sized so this never
 * fires in practice; if it does, the decimation constants above are wrong.
 */
export function assertBudget(assembled: string, charBudget: number): void {
  if (assembled.length > charBudget) {
    throw new Error(
      `repair context exceeded its hard per-iteration budget ` +
        `(${assembled.length} > ${charBudget} chars). A growing context is a bug, ` +
        `not a truncation event — the assembly decimation is under-tight.`,
    );
  }
}

function relatedSuffix(related: string[] | undefined): string {
  if (!related || related.length === 0) return "";
  return ` (${related.join(", ")})`;
}

/** A decimated measurement excerpt: the first few scalar measurements. */
function measurementExcerpt(report: SimulationReportLike | null): string | null {
  if (!report) return null;
  const lines: string[] = [];
  for (const r of report.reports) {
    const meas = (r as ReportEntry).measurements;
    if (meas && typeof meas === "object") {
      for (const [k, v] of Object.entries(meas)) {
        if (lines.length >= MAX_MEASUREMENTS) break;
        lines.push(`  ${k} = ${String(v)}`);
      }
    }
    if (lines.length >= MAX_MEASUREMENTS) break;
  }
  return lines.length ? lines.join("\n") : null;
}
