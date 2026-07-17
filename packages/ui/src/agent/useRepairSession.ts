/**
 * The autonomous-repair session hook (issue #19): drives the client-side repair
 * loop over the CURRENT design, streaming the iteration timeline to the UI and
 * applying each gated fix through the design store's single write path.
 *
 * This is the flagship demo, entirely in the browser: point it at a broken
 * design and it iterates simulate → diagnose → patch → re-simulate until the
 * constraints pass, every proposed fix forced through the #18 gate (the loop
 * only ever surfaces gated `ValidatedDesign`s; nothing reaches editor state
 * except via `applyValidated`). It REPLACES the old backend `/ai-repair` call.
 */

import { useCallback, useRef, useState } from "react";
import {
  MockProvider,
  runRepairLoop,
  createProvider,
  KeyVault,
  DEFAULT_TOKEN_BUDGET,
  type RepairLoopEvent,
  type RepairIteration,
  type RepairResult,
  type RepairStopReason,
  type DesignEvaluation,
  type AppliedStep,
  type MockFixture,
  type NetworkProviderId,
} from "agent";
import { useDesignStore, designSnapshot } from "./designStore";
import { createUiEngineHooks } from "./engineHooks";

/** A live timeline row the repair panel renders. */
export interface RepairTimelineRow {
  index: number;
  /** The evaluation this iteration diagnosed from (validation + sim + #45). */
  evaluation: DesignEvaluation;
  /** The model's diagnosis prose (accumulates as it streams). */
  diagnosis: string;
  /** The gated patch applied this round, if any (its diff + reasoning). */
  appliedStep?: AppliedStep;
  /** True once this row's iteration ended. */
  done: boolean;
}

export interface RepairSessionConfig {
  provider: NetworkProviderId | "mock";
  model?: string;
  mockFixture?: MockFixture;
  maxTokensPerTurn?: number;
  maxIterations?: number;
}

/** The distinct final states the panel renders (each its own visual). */
export interface RepairOutcome {
  reason: RepairStopReason;
  message: string;
  fixed: boolean;
  iterations: number;
  totalTokens: number;
}

const vault = new KeyVault();

export function useRepairSession() {
  const [timeline, setTimeline] = useState<RepairTimelineRow[]>([]);
  const [outcome, setOutcome] = useState<RepairOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const applyValidated = useDesignStore((s) => s.applyValidated);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setTimeline([]);
    setOutcome(null);
    setStatus("");
  }, []);

  const start = useCallback(
    async (config: RepairSessionConfig) => {
      if (running) return;
      reset();
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const failBeforeRun = (message: string) => {
        setOutcome({
          reason: "provider_error",
          message,
          fixed: false,
          iterations: 0,
          totalTokens: 0,
        });
        setStatus("");
        setRunning(false);
        abortRef.current = null;
      };

      // Build the provider: mock replays a fixture; a network provider needs a
      // key from the local vault (never leaves the browser, #17).
      let provider;
      try {
        if (config.provider === "mock") {
          provider = new MockProvider(config.mockFixture ?? { turns: [] });
        } else {
          const key = vault.get(config.provider);
          if (!key) {
            failBeforeRun(`No ${config.provider} API key stored. Add one in Settings.`);
            return;
          }
          const baseUrl = vault.getBaseUrl(config.provider);
          provider = createProvider(config.provider, {
            apiKey: key,
            ...(config.model ? { model: config.model } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          });
        }
      } catch (err) {
        failBeforeRun(`Could not start repair: ${(err as Error).message}`);
        return;
      }

      const snap = designSnapshot();

      const upsertRow = (index: number, patch: Partial<RepairTimelineRow>) => {
        setTimeline((prev) => {
          const existing = prev.find((r) => r.index === index);
          if (existing) {
            return prev.map((r) => (r.index === index ? { ...r, ...patch } : r));
          }
          return [...prev, { index, diagnosis: "", done: false, ...patch } as RepairTimelineRow];
        });
      };

      const onEvent = (ev: RepairLoopEvent) => {
        switch (ev.type) {
          case "iteration-start":
            setStatus(`Iteration ${ev.index + 1}: diagnosing…`);
            upsertRow(ev.index, { evaluation: ev.evaluation });
            break;
          case "diagnosis":
            upsertRow(ev.index, { diagnosis: ev.text });
            break;
          case "patch-applied":
            setStatus(`Iteration ${ev.index + 1}: applied a fix, re-simulating…`);
            upsertRow(ev.index, { appliedStep: ev.step });
            // Apply the gated fix to the editor via the SINGLE write path. The
            // loop only ever hands us a gated ValidatedDesign.
            applyValidated(ev.step.design);
            break;
          case "iteration-end":
            upsertRow(ev.index, { done: true });
            break;
          case "done":
            finalize(ev.result);
            break;
        }
      };

      const finalize = (result: RepairResult) => {
        setOutcome({
          reason: result.reason,
          message: result.message,
          fixed: result.reason === "fixed",
          iterations: result.iterations.length,
          totalTokens: result.totalTokens,
        });
        setStatus("");
      };

      try {
        await runRepairLoop({
          design: snap.xml,
          provider,
          hooks: createUiEngineHooks(),
          signal: controller.signal,
          maxTokensPerTurn: config.maxTokensPerTurn ?? DEFAULT_TOKEN_BUDGET,
          ...(config.maxIterations ? { maxIterations: config.maxIterations } : {}),
          ...(config.model ? { modelId: config.model } : {}),
          onEvent,
        });
      } catch (err) {
        setOutcome({
          reason: "error",
          message: `Repair run failed: ${(err as Error).message}`,
          fixed: false,
          iterations: 0,
          totalTokens: 0,
        });
        setStatus("");
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
    },
    [running, reset, applyValidated],
  );

  return { timeline, outcome, running, status, start, stop, reset };
}

export type { RepairIteration };
