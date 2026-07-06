/**
 * Provider factory: construct a network `AgentProvider` by id. The mock provider
 * is constructed directly from a fixture (see `MockProvider`) because it takes no
 * key and needs its script, so it is intentionally not part of this factory.
 */

import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import type { AgentProvider, ProviderId, ProviderOptions } from "./types.js";

/**
 * Providers this factory constructs: the three BYOK network providers.
 *
 * `mock` is out because it takes a fixture, not a `ProviderOptions`. `house`
 * (issue #20) is out because it takes no user key — construct `HouseProvider`
 * directly with a `HouseProviderOptions` (a URL from `VITE_HOUSE_AGENT_URL`,
 * not an `apiKey`). Keeping the factory narrow means adding the house lane
 * did NOT widen the BYOK code path.
 */
export type NetworkProviderId = Exclude<ProviderId, "mock" | "house">;

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
