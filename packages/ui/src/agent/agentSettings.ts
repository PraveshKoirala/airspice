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
import type { NetworkProviderId } from "agent";

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
}

export const useAgentSettings = create<AgentSettingsState>()(
  persist(
    (set) => ({
      autoApply: false,
      setAutoApply: (on) => set({ autoApply: on }),
      malformedCount: 0,
      incMalformed: () => set((s) => ({ malformedCount: s.malformedCount + 1 })),
      resetMalformed: () => set({ malformedCount: 0 }),
      agentProvider: 'openai',
      setAgentProvider: (provider) => set({ agentProvider: provider }),
      agentModel: 'gemini-3.5-flash-high',
      setAgentModel: (model) => set({ agentModel: model }),
      freeTextModel: 'gemini-3.5-flash-high',
      setFreeTextModel: (model) => set({ freeTextModel: model }),
    }),
    {
      name: 'airspice.agent.settings',
    }
  )
);
