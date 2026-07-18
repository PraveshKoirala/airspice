/**
 * First-run agent defaults for the local OpenAI-compatible proxy.
 *
 * The dev/demo deployment runs an OpenAI-style proxy on localhost:8317 with a
 * shared test key, so the app must work the moment it opens — no Settings trip.
 * Seeding happens ONLY when no key is stored for the openai lane; a user who
 * later saves their own key/base URL in Settings is never overwritten.
 */

import { KeyVault } from "agent";

export const LOCAL_PROXY_BASE_URL = "http://localhost:8317/v1";
export const LOCAL_PROXY_KEY = "test-key-123";
// The proxy's Claude tiers rate-limit hard under sustained use (429
// model_cooldown for ~1.5h). The Gemini pro tier is the reliable default on
// this proxy — it built 71/71 circuits in the refinement loop. Switch models
// any time in Settings.
export const LOCAL_PROXY_MODEL = "gemini-3.1-pro-low";

export function seedLocalProxyDefaults(): void {
  const vault = new KeyVault();
  if (!vault.has("openai")) {
    vault.set("openai", LOCAL_PROXY_KEY);
    vault.setBaseUrl("openai", LOCAL_PROXY_BASE_URL);
  }
}
