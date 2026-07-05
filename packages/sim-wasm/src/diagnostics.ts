/**
 * ngspice stderr -> structured SimDiagnostic mapping (issue #13 deliverable 5).
 *
 * ngspice reports failures as free-text lines on stderr. This module turns the
 * common, actionable ones into stable, matchable `SimDiagnostic` codes with a
 * human hint, so the UI (and #14's report pipeline) can react programmatically
 * instead of string-scanning raw output. See docs/sim_errors.md for the table
 * and the reproducing netlist per code.
 *
 * IMPORTANT: this is a CLASSIFIER, not a filter. Every stderr line still reaches
 * the client as a `stderr` event (issue guardrail: never swallow stderr). This
 * module only decides whether a captured stderr blob ALSO warrants a structured
 * error diagnostic, and which code.
 *
 * Determinism: rules are tried in array order and the FIRST match wins, so a
 * given stderr blob always maps to the same code across runs and platforms.
 */

import type { SimDiagnostic } from "./protocol";

interface Rule {
  code: string;
  /** Case-insensitive test against a single stderr line. */
  match: RegExp;
  message: string;
  hint: string;
  severity: "error" | "warning";
}

/**
 * Ordered rules. Order matters only where patterns could overlap; the more
 * specific pattern is listed first. Each `code` has a reproducing netlist and a
 * test (see tests/diagnostics.test.ts and docs/sim_errors.md).
 */
const RULES: readonly Rule[] = [
  {
    code: "SIM-SINGULAR-MATRIX",
    // "singular matrix:  check nodes ..." / "Matrix is singular"
    match: /singular matrix|matrix is singular/i,
    message: "The circuit matrix is singular (no unique DC solution).",
    hint:
      "A node has no DC path to ground, or two ideal sources conflict. Add a " +
      "resistor to ground on the floating node, or check for a shorted/duplicated source.",
    severity: "error",
  },
  {
    code: "SIM-TIMESTEP-TOO-SMALL",
    // "Timestep too small; time = ..., timestep = ...: trouble with node ..."
    match: /timestep too small/i,
    message: "The transient solver could not converge (timestep went to zero).",
    hint:
      "Usually a discontinuity or an under-damped/stiff node. Add a small series " +
      "resistance or snubber, soften step sources (finite rise/fall), or relax " +
      "reltol; check the node named in the raw output.",
    severity: "error",
  },
  {
    code: "SIM-UNKNOWN-DEVICE",
    // "unknown device type ..." / "unrecognized device"
    match: /unknown device|unrecognized device|unknown subckt/i,
    message: "The netlist references a device or subcircuit ngspice does not know.",
    hint:
      "Check the device prefix (R/C/L/V/I/M/Q/D...) and that any .model or .subckt " +
      "it needs is defined before use.",
    severity: "error",
  },
  {
    code: "SIM-MODEL-NOT-FOUND",
    // "unable to find definition of model ..." / "could not find a model"
    match: /unable to find definition of model|can'?t find.*model|no model|model.*not found/i,
    message: "A device references a .model that was not defined.",
    hint:
      "Add the missing `.model <name> <type>(...)` line, or fix the model name on the device.",
    severity: "error",
  },
  {
    code: "SIM-GND-MISSING",
    // "Warning: mismatch ... " ground-related / "circuit does not have a ground"
    match: /does not have a ground|no ground|ground node.*not/i,
    message: "The circuit has no ground (node 0) reference.",
    hint: "Every ngspice circuit needs node 0 as ground. Connect a net to 0.",
    severity: "error",
  },
  {
    code: "SIM-PARSE-ERROR",
    // "Error on line ..." / "parse error" / "Error: unknown parameter"
    match: /parse error|error on line|unknown parameter|syntax error|bad syntax/i,
    message: "ngspice could not parse a line of the netlist.",
    hint: "Check the line named in the raw output for a typo, bad unit, or missing token.",
    severity: "error",
  },
  {
    code: "SIM-GMIN-STEPPING-FAILED",
    // "Last node voltages ..." preceded by gmin/source stepping failure
    match: /gmin stepping failed|source stepping failed|no convergence in.*dc/i,
    message: "DC operating-point analysis failed to converge.",
    hint:
      "Provide `.nodeset`/`.ic` hints, add gmin, or check for a positive-feedback " +
      "loop with no stable operating point.",
    severity: "error",
  },
];

/** A generic error code used when stderr clearly failed but matched no rule. */
export const UNCLASSIFIED_CODE = "SIM-UNKNOWN";

/**
 * Words that mark a stderr line as an actual error (vs. an informational note).
 * ngspice prints a lot of benign chatter on stderr; we only synthesize an error
 * diagnostic for lines that look like failures.
 */
const ERROR_MARKER_RE = /\berror\b|\bfatal\b|singular|timestep too small|aborted|cannot|could not|unable to/i;

/** Lines ngspice always prints that are NOT failures -- never treat as errors. */
const BENIGN_RE = /can'?t find the initialization file spinit|using sparse|note: can'?t find/i;

/**
 * Classify a captured stderr blob into structured diagnostics.
 *
 * Returns one diagnostic per matched rule (deduplicated by code, first
 * occurrence wins) PLUS, if the blob contains an error marker that matched no
 * rule, a single UNCLASSIFIED diagnostic carrying the offending line. Returns []
 * when stderr contains no error markers (warnings/notes only) -- the run then
 * succeeds and the raw lines were already streamed as `stderr` events.
 */
export function classifyStderr(stderr: string): SimDiagnostic[] {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: SimDiagnostic[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (BENIGN_RE.test(line)) continue;
    for (const rule of RULES) {
      if (rule.match.test(line) && !seen.has(rule.code)) {
        seen.add(rule.code);
        out.push({
          code: rule.code,
          message: rule.message,
          hint: rule.hint,
          severity: rule.severity,
          raw: line,
        });
      }
    }
  }

  // If nothing matched a rule but an error marker is present, surface it as
  // UNCLASSIFIED rather than silently succeeding -- an unknown failure is still
  // a failure the caller must see.
  if (out.length === 0) {
    const errLine = lines.find((l) => !BENIGN_RE.test(l) && ERROR_MARKER_RE.test(l));
    if (errLine) {
      out.push({
        code: UNCLASSIFIED_CODE,
        message: "ngspice reported an error that is not yet mapped to a hint.",
        hint: "See the raw output. If this is common, add a rule in diagnostics.ts.",
        severity: "error",
        raw: errLine,
      });
    }
  }

  return out;
}

/** True iff the classification contains at least one error-severity diagnostic. */
export function hasError(diagnostics: readonly SimDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
