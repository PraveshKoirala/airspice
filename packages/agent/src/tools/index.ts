/**
 * Browser agent tool runtime — public surface (issue #18).
 *
 * The security-critical heart of the agent layer: the deterministic validation
 * gate (`gateDesign` / `ValidatedDesign` — the single write path), the tool
 * registry + runtime (proposals staged, never written directly), version-stamped
 * proposal staging with conflict/rebase, loop budgets, bounded tool results, the
 * ported prompts, and the conversation runner.
 */

// The single write path (the invariant).
export { gateDesign } from "./validated.js";
export type { ValidatedDesign, GateResult } from "./validated.js";

// The engine seam (air-ts / sim-wasm operations the runtime consumes).
export type {
  EngineHooks,
  GateDiagnostic,
  PatchPreviewResult,
  WaveformSummary,
  SimulationReportLike,
  RegistryListing,
} from "./engine.js";

// Tool registry (JSON-schema specs).
export {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  READ_WAVEFORM_MAX_POINTS,
} from "./registry.js";
export type { ToolName } from "./registry.js";

// The runtime (tool execution + staging area).
export { ToolRuntime } from "./runtime.js";
export type {
  DesignSnapshot,
  ToolExecution,
  ToolRuntimeOptions,
} from "./runtime.js";

// Proposal staging + the version-stamped conflict/rebase resolution.
export { isStale, resolveApply } from "./staging.js";
export type {
  StagedProposal,
  ProposalSource,
  ApplyOutcome,
} from "./staging.js";

// Budgets.
export { BudgetCounter, DEFAULT_BUDGET } from "./budget.js";
export type { BudgetLimits, BudgetUsage, BudgetExhaustion } from "./budget.js";

// Tool-result hygiene.
export {
  capToolResult,
  capString,
  stableStringify,
  summarizeStderr,
  DEFAULT_RESULT_CHAR_CAP,
} from "./truncate.js";

// Ported prompts (verbatim; provenance in prompts.ts).
export {
  airContract,
  chatSystemInstruction,
  repairSystemInstruction,
  GOLDEN_DESIGN,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "./prompts.js";

// The conversation runner (tool loop + budgets + recovery ladder + Stop).
export { runConversation } from "./conversation.js";
export type {
  RunnerEvent,
  RunEndReason,
  RunConversationOptions,
} from "./conversation.js";
