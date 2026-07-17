/**
 * Agent UI settings (issue #18): the auto-apply toggle (default OFF) and the
 * per-session malformed-tool-call counter (surfaced in the settings panel).
 *
 * AUTO-APPLY default OFF is binding (deliverable 2): even when ON, auto-apply
 * runs the FULL gate — it only removes the human Apply click, never the gate.
 * A staged proposal that passed the gate is what gets auto-applied; a gate
 * FAILURE is fed back to the model, never applied. So this flag chooses WHO
 * confirms (user vs. auto), not WHETHER the gate runs.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_TOKEN_BUDGET, MODEL_CATALOG, type NetworkProviderId } from "agent";

const DEFAULT_PROVIDER: NetworkProviderId = "openai";
const DEFAULT_MODEL = MODEL_CATALOG[DEFAULT_PROVIDER].defaultModel;
// Model ids a previous build persisted as the openai-lane default; they upgrade
// to the current catalog default (the local proxy's tool-calling model).
const STALE_DEFAULTS = new Set(["gemini-3.5-flash-high", "gpt-4o-mini"]);

function migratePersistedSettings(persisted: unknown): unknown {
  if (typeof persisted !== "object" || persisted === null) return persisted;
  const state = persisted as Record<string, unknown>;
  if (
    state.agentProvider === DEFAULT_PROVIDER &&
    (STALE_DEFAULTS.has(state.agentModel as string) ||
      STALE_DEFAULTS.has(state.freeTextModel as string) ||
      !state.agentModel)
  ) {
    return { ...state, agentModel: DEFAULT_MODEL, freeTextModel: "" };
  }
  return state;
}

export interface AgentSettingsState {
  /** Auto-apply staged proposals (still through the full gate). Default OFF. */
  autoApply: boolean;
  setAutoApply: (on: boolean) => void;
  /** Malformed-tool-call events observed this session (recovery-ladder counter). */
  malformedCount: number;
  incMalformed: () => void;
  resetMalformed: () => void;
  agentProvider: NetworkProviderId | 'mock';
  setAgentProvider: (provider: NetworkProviderId | 'mock') => void;
  agentModel: string;
  setAgentModel: (model: string) => void;
  freeTextModel: string;
  setFreeTextModel: (model: string) => void;
  /** Per-turn token budget handed to chat + repair sessions. */
  tokenBudget: number;
  setTokenBudget: (budget: number) => void;
}

export const useAgentSettings = create<AgentSettingsState>()(
  persist(
    (set) => ({
      autoApply: false,
      setAutoApply: (on) => set({ autoApply: on }),
      malformedCount: 0,
      incMalformed: () => set((s) => ({ malformedCount: s.malformedCount + 1 })),
      resetMalformed: () => set({ malformedCount: 0 }),
      agentProvider: DEFAULT_PROVIDER,
      setAgentProvider: (provider) => set({ agentProvider: provider }),
      agentModel: DEFAULT_MODEL,
      setAgentModel: (model) => set({ agentModel: model }),
      freeTextModel: '',
      setFreeTextModel: (model) => set({ freeTextModel: model }),
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      setTokenBudget: (budget) => set({ tokenBudget: budget }),
    }),
    {
      name: 'airspice.agent.settings',
      version: 2,
      migrate: migratePersistedSettings,
    }
  )
);
