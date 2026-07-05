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
