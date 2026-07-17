/**
 * The browser agent session hook (issue #18): orchestrates one conversation run
 * against the tool runtime, staging proposals for the user, and enforcing the
 * budgets + Stop. This REPLACES the old backend `/agent/chat` path in App.tsx —
 * the model is called directly from the browser (BYOK, #17) and every tool runs
 * client-side against air-ts + sim-wasm.
 *
 * The single-write-path invariant lives at the store boundary: a proposal is
 * applied ONLY via `useDesignStore.applyValidated`, which takes a
 * `ValidatedDesign` produced solely by the gate. Auto-apply (default OFF) routes
 * through the SAME apply — it removes the click, not the gate.
 */

import { useCallback, useRef, useState } from "react";
import {
  MockProvider,
  ToolRuntime,
  runConversation,
  resolveApply,
  chatSystemInstruction,
  createProvider,
  KeyVault,
  DEFAULT_TOKEN_BUDGET,
  type RunnerEvent,
  type StagedProposal,
  type BudgetUsage,
  type Msg,
  type MockFixture,
  type NetworkProviderId,
} from "agent";
import { parse as parseAir } from "air-ts";
import { useDesignStore, designSnapshot } from "./designStore";
import { useAgentSettings } from "./agentSettings";
import { useProjectStore } from "../storage/projectStore";
import { createUiEngineHooks } from "./engineHooks";

/** A chat transcript entry the panel renders. */
export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
}

/** A proposal shown in the UI with its live status (stale badge / applied). */
export interface UiProposal {
  proposal: StagedProposal;
  status: "staged" | "applied" | "rejected" | "conflict";
  note?: string;
  /** For a conflict: the current design to diff "mine" against. */
  conflictCurrentXml?: string;
}

export interface AgentSessionConfig {
  /** Which provider to use; "mock" replays a fixture (dev/demo/CI parity). */
  provider: NetworkProviderId | "mock";
  /** Model id (curated pick or free text). */
  model?: string;
  /** Fixture for the mock provider (when provider === "mock"). */
  mockFixture?: MockFixture;
  /** Token budget per turn (settings). */
  maxTokensPerTurn?: number;
}

const vault = new KeyVault();

/**
 * When the agent delivers a design into a project still called "Untitled
 * Project", adopt the design's own title so the workspace header, landing list,
 * and design metadata stop disagreeing. Best-effort: a parse failure changes
 * nothing.
 */
function maybeAdoptDesignTitle(xml: string): void {
  try {
    const store = useProjectStore.getState();
    const active = store.projectsList.find((p) => p.id === store.activeProjectId);
    if (!active || active.name !== "Untitled Project") return;
    const title = parseAir(xml).metadata.title.trim();
    if (title && title !== "Blank Design") void store.renameProject(active.id, title);
  } catch {
    // best-effort only
  }
}

export function useAgentSession() {
  const [transcript, setTranscript] = useState<ChatEntry[]>([]);
  const [proposals, setProposals] = useState<UiProposal[]>([]);
  const [budget, setBudget] = useState<BudgetUsage | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const historyRef = useRef<Msg[]>([]);

  const applyValidated = useDesignStore((s) => s.applyValidated);
  const autoApply = useAgentSettings((s) => s.autoApply);
  const incMalformed = useAgentSettings((s) => s.incMalformed);

  const push = useCallback((entry: Omit<ChatEntry, "id">) => {
    setTranscript((prev) => [...prev, { ...entry, id: `${prev.length}-${Date.now()}` }]);
  }, []);

  /** Apply a staged proposal via the SINGLE write path (gate-enforced). */
  const applyProposal = useCallback(
    (proposal: StagedProposal) => {
      const snap = designSnapshot();
      const outcome = resolveApply(proposal, snap.xml, snap.version, createUiEngineHooks());
      setProposals((prev) =>
        prev.map((p) => {
          if (p.proposal.id !== proposal.id) return p;
          switch (outcome.status) {
            case "clean":
              applyValidated(outcome.design);
              maybeAdoptDesignTitle(outcome.design.xml);
              return { ...p, status: "applied" };
            case "rebased":
              applyValidated(outcome.design);
              maybeAdoptDesignTitle(outcome.design.xml);
              return { ...p, status: "applied", note: outcome.note };
            case "conflict":
              return { ...p, status: "conflict", note: outcome.note, conflictCurrentXml: outcome.currentXml };
            case "stale_gate_failed":
              return { ...p, status: "conflict", note: outcome.note };
          }
        }),
      );
    },
    [applyValidated],
  );

  const rejectProposal = useCallback((proposal: StagedProposal) => {
    setProposals((prev) =>
      prev.map((p) => (p.proposal.id === proposal.id ? { ...p, status: "rejected" } : p)),
    );
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (message: string, config: AgentSessionConfig) => {
      if (running) return;
      push({ role: "user", content: message });
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      // Build the provider: mock replays a fixture; a network provider needs a
      // key from the local vault (never leaves the browser, #17).
      let provider;
      try {
        if (config.provider === "mock") {
          provider = new MockProvider(config.mockFixture ?? { turns: [] });
        } else {
          const key = vault.get(config.provider);
          if (!key) {
            push({ role: "system", content: `No ${config.provider} API key stored. Add one in Settings.` });
            setRunning(false);
            return;
          }
          const baseUrl = vault.getBaseUrl(config.provider);
          provider = createProvider(config.provider, { 
            apiKey: key, 
            ...(config.model ? { model: config.model } : {}),
            ...(baseUrl ? { baseUrl } : {}) 
          });
        }
      } catch (err) {
        console.error("Agent startup failed:", err);
        push({ role: "system", content: `Could not start the agent: ${(err as Error).message}` });
        setRunning(false);
        return;
      }

      const snap = designSnapshot();
      const runtime = new ToolRuntime(snap, { hooks: createUiEngineHooks() });

      let assistantBuf = "";
      const flushAssistant = () => {
        if (assistantBuf.trim()) push({ role: "assistant", content: assistantBuf });
        assistantBuf = "";
      };

      let turnEmittedContent = false;

      const onEvent = (ev: RunnerEvent) => {
        if (ev.type === "assistant-text" || ev.type === "tool-call") {
          turnEmittedContent = true;
        }
        switch (ev.type) {
          case "assistant-text":
            assistantBuf += ev.text;
            break;
          case "tool-call":
            flushAssistant();
            push({ role: "system", content: `→ ${ev.name}(${summarizeArgs(ev.args)})` });
            // Refresh the runtime's snapshot before the next tool sees it, so a
            // mid-run user edit is reflected (version-stamped staging).
            runtime.setDesignSnapshot(designSnapshot());
            break;
          case "proposal-staged":
            setProposals((prev) => [...prev, { proposal: ev.proposal, status: "staged" }]);
            if (autoApply) applyProposal(ev.proposal);
            break;
          case "system-note":
            push({ role: "system", content: ev.note });
            break;
          case "malformed":
            incMalformed();
            break;
          case "budget":
            setBudget(ev.usage);
            break;
          case "error":
            flushAssistant();
            console.error("Provider stream error:", ev);
            push({ role: "system", content: `Provider error: ${ev.message}` });
            break;
          case "done":
            flushAssistant();
            if (ev.reason !== "completed") {
              push({ role: "system", content: `Run ended: ${humanReason(ev.reason)}` });
            }
            break;
        }
      };

      try {
        const { messages } = await runConversation({
          provider,
          runtime,
          userMessage: message,
          history: historyRef.current,
          system: chatSystemInstruction(),
          maxTokensPerTurn: config.maxTokensPerTurn ?? DEFAULT_TOKEN_BUDGET,
          signal: controller.signal,
          onEvent,
          ...(config.model ? { modelId: config.model } : {}),
        });
        historyRef.current = messages;
        if (!turnEmittedContent) {
          push({ role: "system", content: "Run ended immediately with no outputs (check provider configuration or mock fixture)." });
        }
      } catch (err) {
        console.error("Agent run failed with exception:", err);
        push({ role: "system", content: `Agent run failed: ${(err as Error).message}` });
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running, push, autoApply, applyProposal, incMalformed],
  );

  return { transcript, proposals, budget, running, send, stop, applyProposal, rejectProposal };
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return keys.map((k) => (typeof args[k] === "string" && (args[k] as string).length > 24 ? `${k}: …` : `${k}`)).join(", ");
}

function humanReason(reason: string): string {
  switch (reason) {
    case "budget_iterations":
      return "iteration budget reached";
    case "budget_tokens":
      return "token budget reached";
    case "budget_wall_time":
      return "time budget reached";
    case "aborted":
      return "stopped";
    case "malformed_twice":
      return "the model produced unparseable tool calls twice";
    case "provider_error":
      return "provider error";
    default:
      return reason;
  }
}
