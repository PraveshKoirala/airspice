/**
 * Provider factory: construct a network `AgentProvider` by id. The mock provider
 * is constructed directly from a fixture (see `MockProvider`) because it takes no
 * key and needs its script, so it is intentionally not part of this factory.
 */

import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { AgentProvider, ProviderId, ProviderOptions } from "./types.js";

export type NetworkProviderId = Exclude<ProviderId, "mock">;

export function createProvider(
  id: NetworkProviderId,
  opts: ProviderOptions,
): AgentProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicProvider(opts);
    case "openai":
      return new OpenAIProvider(opts);
    case "gemini":
      return new GeminiProvider(opts);
  }
}
