/**
 * Proposal staging — the security core's data model (issue #18 deliverable 2 +
 * the binding post-audit "concurrent edits: version-stamped proposals").
 *
 * Every design mutation the runtime produces lands here as a STAGED proposal,
 * never a direct write. The UI renders a Monaco diff (current vs proposed) and
 * the user Applies or Rejects. Auto-apply is a user setting (default OFF) that
 * still runs the FULL gate; a gate failure feeds diagnostics back to the model
 * instead of applying.
 *
 * VERSION STAMPING (post-audit amendment, binding):
 *   1. Design state carries a monotonically increasing version number (owned by
 *      the UI store; passed in as `baseVersion` when a proposal is computed).
 *      Every staged proposal records the baseVersion it was computed from.
 *   2. On Apply: if currentVersion === baseVersion, apply normally. If not,
 *      REBASE — re-run the FULL gate against the CURRENT document (via the patch
 *      or full XML), and if it still applies cleanly, apply and note "applied
 *      over newer edits"; if it conflicts, flip to a CONFLICT state showing both
 *      diffs; the user chooses. There is NO silent-overwrite path.
 *   3. A staged proposal is NOT auto-invalidated by user edits: it stays visible
 *      with a "design has changed since this was proposed" badge (see `isStale`).
 *
 * This module is pure data + pure resolution logic (gate/patch supplied via
 * EngineHooks). The React store wiring lives in the UI.
 */

import type { ValidatedDesign, GateResult } from "./validated.js";
import { gateDesign } from "./validated.js";
import type { EngineHooks, GateDiagnostic } from "./engine.js";

/** How a proposal was produced — drives the rebase strategy on Apply. */
export type ProposalSource =
  | { kind: "full"; designXml: string } // set_design: a full replacement doc
  | { kind: "patch"; patchXml: string }; // propose_patch: a diff to re-apply

/** A proposal awaiting the user's Apply/Reject, stamped with its base version. */
export interface StagedProposal {
  /** Stable id for UI keying / correlating the tool call. */
  id: string;
  /** Human summary the model supplied (for the chat + diff header). */
  summary: string;
  /** The gated, canonical proposed XML (the "proposed" side of the diff). */
  readonly validated: ValidatedDesign;
  /** How to recompute the proposal if the base moved (for rebase on Apply). */
  source: ProposalSource;
  /** The design version this proposal was computed from (amendment point 1). */
  baseVersion: number;
  /** Non-error diagnostics that accompanied the passing gate (warnings/info). */
  diagnostics: readonly GateDiagnostic[];
}

/** True when the live design has advanced past the proposal's base version. */
export function isStale(proposal: StagedProposal, currentVersion: number): boolean {
  return currentVersion !== proposal.baseVersion;
}

/**
 * The outcome of an Apply attempt. `clean` and `rebased` both yield a
 * ValidatedDesign to write; `conflict` yields nothing to write and both diffs
 * for the user to choose between; `stale_gate_failed` means the rebase gate
 * itself failed (the proposal no longer validates against the current doc).
 */
export type ApplyOutcome =
  | { status: "clean"; design: ValidatedDesign }
  | { status: "rebased"; design: ValidatedDesign; note: string }
  | {
      status: "conflict";
      /** The proposal as originally staged (against its old base). */
      proposed: ValidatedDesign;
      /** The current live design (the "mine" side). */
      currentXml: string;
      note: string;
    }
  | { status: "stale_gate_failed"; diagnostics: GateDiagnostic[]; note: string };

/**
 * Resolve an Apply against the CURRENT design + version (amendment point 2).
 *
 * - Versions match -> `clean`: apply the already-gated proposal verbatim.
 * - Versions differ + full-doc proposal -> re-gate the proposal's XML against
 *   nothing-but-itself (a full doc is self-contained): if it still passes, it's
 *   a `rebased` apply "over newer edits"; if it now fails, `stale_gate_failed`.
 *   A full-doc replacement can't textually "conflict" with the current doc — it
 *   REPLACES it — but the user is still told (via the "over newer edits" note in
 *   the UI) that they're discarding newer edits, and may Reject instead.
 * - Versions differ + patch proposal -> RE-APPLY the patch to the CURRENT
 *   design and re-gate: clean re-apply -> `rebased`; a patch that no longer
 *   applies (throws) or fails the gate against the moved base -> `conflict`
 *   (show both diffs; the user picks keep-mine / take-proposal / ask-agent).
 *
 * No branch writes anything; the caller (UI store) writes ONLY a returned
 * ValidatedDesign, and only through its single writer.
 */
export function resolveApply(
  proposal: StagedProposal,
  currentXml: string,
  currentVersion: number,
  hooks: EngineHooks,
): ApplyOutcome {
  if (currentVersion === proposal.baseVersion) {
    return { status: "clean", design: proposal.validated };
  }

  // The base moved. Rebase per the proposal's source kind.
  if (proposal.source.kind === "full") {
    // A full replacement re-gates against itself; it does not merge.
    const result: GateResult = gateDesign(proposal.source.designXml, hooks);
    if (result.ok) {
      return {
        status: "rebased",
        design: result.design,
        note: "applied over newer edits (full design replacement)",
      };
    }
    return {
      status: "stale_gate_failed",
      diagnostics: result.diagnostics,
      note: "the staged design no longer validates; the design changed since it was proposed",
    };
  }

  // Patch proposal: re-apply the diff to the CURRENT document, then re-gate.
  let rebasedXml: string;
  try {
    rebasedXml = hooks.applyPatch(currentXml, proposal.source.patchXml);
  } catch (err) {
    // The patch's target elements no longer exist / changed — a real conflict.
    return {
      status: "conflict",
      proposed: proposal.validated,
      currentXml,
      note: `patch no longer applies to the current design (${(err as Error).message})`,
    };
  }
  const result = gateDesign(rebasedXml, hooks);
  if (result.ok) {
    return {
      status: "rebased",
      design: result.design,
      note: "applied over newer edits (patch re-applied to current design)",
    };
  }
  // The patch applied textually but the merged design fails the gate — conflict.
  return {
    status: "conflict",
    proposed: proposal.validated,
    currentXml,
    note: "patch re-applied but the result no longer validates against the current design",
  };
}
