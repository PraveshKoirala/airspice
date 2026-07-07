/**
 * BYOK key vault (issue #17, ADR 0008, AGENTS.md rule 15).
 *
 * Storage model, binding:
 *   - localStorage ONLY. Never cookies, never IndexedDB shared with project
 *     data, never URL params. One string entry per provider.
 *   - The key is displayed MASKED; the full value is only ever read to hand to a
 *     direct provider call. It is never logged, never put in an error/telemetry.
 *   - A Clear action removes the entry.
 *
 * The vault takes a `Storage`-shaped backend so it is unit-testable in Node with
 * an in-memory stub; in the browser the default is `window.localStorage`. If no
 * storage is available (SSR / locked-down context) the vault degrades to a
 * no-op read (returns undefined) rather than throwing.
 */

import type { ProviderId } from "./types.js";

/** The verbatim security notice shown in the settings UI (issue #17 / #16). */
export const KEY_VAULT_NOTICE =
  "Your key is stored only in this browser and sent only to <provider>. " +
  "Anyone with access to this browser profile can read it. " +
  "Prefer a scoped, low-limit key.";

/** Fill the `<provider>` placeholder in the notice for a concrete provider. */
export function keyVaultNoticeFor(provider: ProviderId): string {
  return KEY_VAULT_NOTICE.replace("<provider>", providerDisplayName(provider));
}

export function providerDisplayName(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "house":
      // The hosted house-agent lane (issue #20). No user key is stored for it,
      // so it never reaches the `slot()`/`get()` paths in practice; the name is
      // used only by exhaustiveness-checked switches like this one.
      return "the house agent";
    case "mock":
      return "the mock provider";
  }
}

const KEY_PREFIX = "airspice.byok.";

/** Minimal storage surface (a subset of the Web Storage API). */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyStorage | null {
  try {
    // `localStorage` exists only in a browser/DOM context.
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw in sandboxed iframes; treat as unavailable.
  }
  return null;
}

export class KeyVault {
  private readonly storage: KeyStorage | null;

  constructor(storage?: KeyStorage) {
    this.storage = storage ?? defaultStorage();
  }

  private slot(provider: ProviderId): string {
    return `${KEY_PREFIX}${provider}`;
  }

  private urlSlot(provider: ProviderId): string {
    return `${KEY_PREFIX}${provider}.baseUrl`;
  }

  /** Read the raw key for a provider (for a direct API call ONLY). */
  get(provider: ProviderId): string | undefined {
    if (!this.storage) return undefined;
    const value = this.storage.getItem(this.slot(provider));
    return value === null ? undefined : value;
  }

  /** Read the custom base URL override for a provider, if set. */
  getBaseUrl(provider: ProviderId): string | undefined {
    if (!this.storage) return undefined;
    const value = this.storage.getItem(this.urlSlot(provider));
    return value === null ? undefined : value;
  }

  /** True when a non-empty key is stored for this provider. */
  has(provider: ProviderId): boolean {
    const v = this.get(provider);
    return typeof v === "string" && v.length > 0;
  }

  /** Store a key. Empty/whitespace-only input clears the slot instead. */
  set(provider: ProviderId, key: string): void {
    if (!this.storage) return;
    const trimmed = key.trim();
    if (trimmed === "") {
      this.clear(provider);
      return;
    }
    this.storage.setItem(this.slot(provider), trimmed);
  }

  /** Store a base URL override. Empty/whitespace-only input clears it. */
  setBaseUrl(provider: ProviderId, url: string): void {
    if (!this.storage) return;
    const trimmed = url.trim();
    if (trimmed === "") {
      this.clearBaseUrl(provider);
      return;
    }
    this.storage.setItem(this.urlSlot(provider), trimmed);
  }

  /** Remove the stored key for a provider (the "Clear" action). */
  clear(provider: ProviderId): void {
    if (!this.storage) return;
    this.storage.removeItem(this.slot(provider));
  }

  /** Remove the stored base URL override for a provider. */
  clearBaseUrl(provider: ProviderId): void {
    if (!this.storage) return;
    this.storage.removeItem(this.urlSlot(provider));
  }

  /**
   * A masked rendering safe to display/log: last 4 characters revealed, the rest
   * as bullets; short keys are fully masked. Returns "" when no key is stored.
   * This is the ONLY string derived from the key that is safe to render.
   */
  masked(provider: ProviderId): string {
    const key = this.get(provider);
    return maskKey(key);
  }
}

/** Mask a key for display: reveal at most the last 4 chars. Never the whole key. */
export function maskKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 4) return "•".repeat(key.length);
  const tail = key.slice(-4);
  return `${"•".repeat(Math.min(key.length - 4, 8))}${tail}`;
}
