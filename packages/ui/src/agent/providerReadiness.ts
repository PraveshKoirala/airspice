/**
 * Provider readiness (issue #28 deliverable 3 & 5 — the BYOK pointer).
 *
 * The repair demo is the ONE feature that needs an AI provider. Everything else
 * (gallery, open, simulate, schematic) is keyless. To show an honest BYOK pointer
 * we need to tell apart "the user has configured their own provider" from "the app
 * is only running on the seeded shared demo proxy" (proxyDefaults seeds an openai
 * key at boot so the demo works out of the box).
 *
 * `hasUserProviderKey` returns true only for a key the USER supplied — the seeded
 * local-proxy placeholder (test-key-123 @ localhost:8317) does NOT count. So on a
 * fresh profile the BYOK pointer shows (there is no user key), while a user who
 * pasted their own key in Settings sees it disappear. The repair loop can still
 * RUN against the shared proxy when it is reachable; the pointer is informational,
 * never a hard gate.
 */

import { KeyVault, type NetworkProviderId } from "agent";
import { LOCAL_PROXY_BASE_URL, LOCAL_PROXY_KEY } from "./proxyDefaults";

/**
 * True when the given provider has a key the user supplied themselves (not the
 * seeded shared-proxy default). `provider === "mock"` is always ready — the mock
 * provider replays a bundled fixture and needs no key.
 */
export function hasUserProviderKey(provider: NetworkProviderId | "mock"): boolean {
  if (provider === "mock") return true;
  const vault = new KeyVault();
  if (!vault.has(provider)) return false;
  // The seeded local-proxy placeholder is a shared demo default, not the user's
  // own BYOK — treat it as "no user key" so the BYOK pointer still shows.
  if (provider === "openai") {
    const key = vault.get(provider);
    const base = vault.getBaseUrl(provider);
    if (key === LOCAL_PROXY_KEY && base === LOCAL_PROXY_BASE_URL) return false;
  }
  return true;
}

/**
 * True when SOME key is configured for this provider — the seeded shared-proxy
 * default OR a real BYOK key. This is the gate for whether the repair loop can
 * actually run: with any key it runs (against the proxy or the user's provider);
 * with NO key at all it must short-circuit to an actionable "add a key" outcome
 * rather than construct/call a provider. `mock` needs no key.
 */
export function hasAnyProviderKey(provider: NetworkProviderId | "mock"): boolean {
  if (provider === "mock") return true;
  return new KeyVault().has(provider);
}
