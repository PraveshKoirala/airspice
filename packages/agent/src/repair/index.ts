/**
 * The autonomous repair loop — public surface (issue #19).
 *
 * The flagship differentiator: point the agent at a broken design and it
 * iterates simulate → diagnose → patch → re-simulate until the constraints pass,
 * entirely client-side, with every proposed fix forced through the #18 gate. See
 * ./loop.ts for the convergence policy + fresh-context-per-iteration design and
 * ./context.ts for the repair-context assembly + semantic no-progress primitives.
 */

export {
  runRepairLoop,
  isFixed,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONTEXT_CHAR_BUDGET,
  assembleRepairContext,
  diagnosticSignature,
  signaturesEqual,
  evaluateDesign,
} from "./loop.js";
export type {
  RepairStopReason,
  RepairResult,
  RepairIteration,
  RepairLoopOptions,
  RepairLoopEvent,
  AppliedStep,
  AttemptSummary,
  DesignEvaluation,
  DiagnosticSignature,
  RepairContextInput,
} from "./loop.js";
export { assertBudget } from "./context.js";
