/**
 * Public surface of the browser BYOK agent layer (issue #17).
 *
 * Everything here is browser-safe ESM: providers call the model directly from
 * the browser (no server, no relay -- ADR 0008), the key vault is localStorage
 * only, and every error path is redacted so the key never reaches a log.
 */

export type {
  AgentEvent,
  AgentProvider,
  ChatRequest,
  DoneEvent,
  ErrorEvent,
  ErrorKind,
  JsonSchema,
  MalformedToolCall,
  Msg,
  ProviderId,
  ProviderOptions,
  RetryConfig,
  TextDeltaEvent,
  ToolCallEvent,
  ToolSpec,
  UsageEvent,
  ValidateKeyResult,
} from "./types.js";

export { AnthropicProvider } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
export { GeminiProvider } from "./providers/gemini.js";
export { MockProvider } from "./providers/mock.js";
export type { MockFixture, ScriptedEvent } from "./providers/mock.js";

export { createProvider } from "./factory.js";
export type { NetworkProviderId } from "./factory.js";

export { AIR_TOOLS } from "./tools.js";
export { MODEL_CATALOG, DEFAULT_TOKEN_BUDGET } from "./models.js";
export type { ModelCatalogEntry } from "./models.js";

export {
  KeyVault,
  KEY_VAULT_NOTICE,
  keyVaultNoticeFor,
  providerDisplayName,
  maskKey,
} from "./vault.js";
export type { KeyStorage } from "./vault.js";

export { redactKey, providerError, RedactedError } from "./redact.js";
export { classifyStatus } from "./http.js";
export {
  parseToolArgs,
  malformedToolResult,
  schemaRef,
} from "./repair.js";
export type { ParsedToolArgs } from "./repair.js";

// Browser agent tool runtime (issue #18): the deterministic validation gate
// (the single write path), the tool registry + runtime, version-stamped proposal
// staging, loop budgets, bounded tool results, ported prompts, and the
// conversation runner. See ./tools/index.ts for the full surface.
export {
  gateDesign,
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  READ_WAVEFORM_MAX_POINTS,
  ToolRuntime,
  isStale,
  resolveApply,
  BudgetCounter,
  DEFAULT_BUDGET,
  capToolResult,
  capString,
  stableStringify,
  summarizeStderr,
  DEFAULT_RESULT_CHAR_CAP,
  airContract,
  chatSystemInstruction,
  GOLDEN_DESIGN,
  runConversation,
} from "./tools/index.js";
export type {
  ValidatedDesign,
  GateResult,
  EngineHooks,
  GateDiagnostic,
  PatchPreviewResult,
  WaveformSummary,
  SimulationReportLike,
  RegistryListing,
  ToolName,
  DesignSnapshot,
  ToolExecution,
  ToolRuntimeOptions,
  StagedProposal,
  ProposalSource,
  ApplyOutcome,
  BudgetLimits,
  BudgetUsage,
  BudgetExhaustion,
  RunnerEvent,
  RunEndReason,
  RunConversationOptions,
} from "./tools/index.js";

export { repairSystemInstruction } from "./tools/index.js";

// The autonomous repair loop (issue #19): the flagship simulate → diagnose →
// patch → re-simulate loop, run entirely client-side, every fix through the #18
// gate. Fresh context per iteration, semantic no-progress detection, and #45
// convergence awareness. See ./repair/index.ts.
export {
  runRepairLoop,
  isFixed,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_CONTEXT_CHAR_BUDGET,
  assembleRepairContext,
  diagnosticSignature,
  signaturesEqual,
  evaluateDesign,
  assertBudget,
} from "./repair/index.js";
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
} from "./repair/index.js";
