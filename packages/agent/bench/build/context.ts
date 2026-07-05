/**
 * Build-context assembly (issue #107) — the per-iteration user message the agent
 * builds from, mirroring #19's `assembleRepairContext` but for the GENERATIVE
 * task: the agent is given the natural-language device spec and (on later
 * iterations) the current design + a COMPACT history of what it already staged,
 * so it can extend/correct rather than start over.
 *
 * FRESH CONTEXT PER ITERATION (the #19 amendment 1 discipline): each iteration
 * rebuilds this message from scratch — the NL prompt + the current design excerpt
 * + a compact prior-attempt summary — under a hard char budget. There is NO
 * growing transcript; the conversation runs with history:[] each iteration.
 *
 * The agent is given ONLY the spec's NL `prompt` — NEVER the criteria (issue #107
 * guardrail: the build passes because the model satisfied the criteria, checked
 * by objective code it never sees).
 */

import { capString } from "../../src/index.js";

/** One prior build attempt, compacted for the next iteration's context. */
export interface BuildAttemptSummary {
  readonly iteration: number;
  /** The staged proposal's one-line summary (NOT the full design). */
  readonly summary: string;
  /** Whether the design changed vs the previous iteration. */
  readonly progressed: boolean;
  /** A short note on why the last build was not accepted (validation/no-stage). */
  readonly note: string;
}

export interface BuildContextInput {
  /** The natural-language device spec — the ONLY task the agent is given. */
  prompt: string;
  /** The current design XML (empty shell on iteration 0). */
  designXml: string;
  /** Whether the current design is the empty shell (iteration 0). */
  isShell: boolean;
  /** COMPACT prior-attempt history (summaries only). */
  history: readonly BuildAttemptSummary[];
  /** 0-based iteration index. */
  iteration: number;
  /** The turn budget (surfaced so the model knows its remaining budget). */
  turnBudget: number;
}

const DESIGN_HEADER = "CURRENT DESIGN (AIR XML):\n";
const MIN_DESIGN_CHARS = 400;
const BUDGET_SLACK = 64;
const MAX_HISTORY = 6;

/** The hard per-iteration char budget (same bound discipline as #19). */
export const DEFAULT_BUILD_CONTEXT_CHAR_BUDGET = 24_000;

/**
 * Assemble the FRESH per-iteration build message. Bounded by construction: the
 * design excerpt is capped so the whole message fits `charBudget`; exceeding it
 * THROWS (a growing context is a bug, mirroring #19's `assertBudget`).
 */
export function assembleBuildContext(input: BuildContextInput, charBudget: number): string {
  const parts: string[] = [];

  parts.push(
    `You are on build iteration ${input.iteration + 1} of at most ${input.turnBudget}. ` +
      "Build the circuit the user describes below as a complete, valid AIR design and " +
      "stage it with set_design. Use list_registry_components to confirm part names, and " +
      "validate_design / run_simulation to check your work before finalizing.",
  );

  parts.push("USER REQUEST:\n" + input.prompt.trim());

  if (input.history.length > 0) {
    const lines = input.history
      .slice(-MAX_HISTORY)
      .map(
        (h) =>
          `- iter ${h.iteration + 1}: ${h.summary}${h.progressed ? "" : " (no change)"}${
            h.note ? ` — ${h.note}` : ""
          }`,
      );
    parts.push(
      "PRIOR ATTEMPTS (compact — refine the current design, do NOT restart from scratch):\n" +
        lines.join("\n"),
    );
  }

  if (!input.isShell) {
    const reserved = parts.join("\n\n").length + DESIGN_HEADER.length + BUDGET_SLACK;
    const designBudget = Math.max(MIN_DESIGN_CHARS, charBudget - reserved);
    const designText = capString(input.designXml, designBudget);
    parts.push(DESIGN_HEADER + designText);
  } else {
    parts.push(
      "There is no design yet — build it from scratch and stage the complete AIR " +
        "<system> document with set_design.",
    );
  }

  const assembled = parts.join("\n\n");
  if (assembled.length > charBudget) {
    throw new Error(
      `build context exceeded its hard per-iteration budget (${assembled.length} > ${charBudget} chars). ` +
        "A growing context is a bug, not a truncation event — tighten the design excerpt.",
    );
  }
  return assembled;
}
