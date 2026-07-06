/**
 * Curated per-provider model catalog + defaults (issue #17 deliverable 4:
 * "model picker: curated list per provider + free-text override").
 *
 * Defaults:
 *   - Anthropic: `claude-sonnet-5` (specified verbatim in the issue).
 *   - Gemini / OpenAI: ported from the Python `prompts.py` DEFAULT_*_MODEL
 *     constants so the browser layer starts on the same models the prompts were
 *     tuned against.
 *
 * The lists are a curated starting point for the settings picker; the UI also
 * accepts a free-text model id, so a newly released model needs no code change.
 */

import type { ProviderId } from "./types.js";

export interface ModelCatalogEntry {
  defaultModel: string;
  models: readonly string[];
}

// PROVENANCE: gemini-3.5-flash and gpt-4o-mini mirror prompts.py's
// DEFAULT_GEMINI_MODEL / DEFAULT_OPENAI_MODEL. claude-sonnet-5 is from issue #17.
// The house-agent lane (issue #20) owns its own model tier (the Worker enforces
// it), so `house` is intentionally excluded from this catalog too — the
// SettingsPanel BYOK picker only iterates the network providers below.
export const MODEL_CATALOG: Record<Exclude<ProviderId, "mock" | "house">, ModelCatalogEntry> = {
  anthropic: {
    defaultModel: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5"],
  },
  gemini: {
    defaultModel: "gemini-3.5-flash",
    models: ["gemini-3.5-flash", "gemini-3.5-pro", "gemini-2.5-flash"],
  },
  openai: {
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "o4-mini"],
  },
};

/** Default token budget shown in the settings UI (deliverable 4). */
export const DEFAULT_TOKEN_BUDGET = 4096;
