/**
 * The tool runtime (issue #18 deliverable 1): executes the model's tool calls
 * against air-ts (#8/#11/#14) + sim-wasm (#13) via the EngineHooks seam, and
 * owns the proposal-staging area (deliverable 2).
 *
 * INVARIANT — the single write path. `set_design` and `propose_patch` are the
 * ONLY tools that mutate the design, and NEITHER writes editor state: they
 * produce a `ValidatedDesign` via `gateDesign` and STAGE it. A gate FAILURE is
 * fed back to the model as the tool result (diagnostics JSON); nothing is
 * applied. The actual write of editor state happens later, only when the user
 * (or auto-apply, still through the gate) Applies a staged proposal — and only
 * through the UI's single writer, which accepts nothing but a `ValidatedDesign`.
 * Grep `gateDesign(` to enumerate every construction; there is no other.
 *
 * BOUNDEDNESS — every tool result goes through `capToolResult` (deliverable 4):
 * head+tail truncation with an explicit `[truncated]` marker, deterministic
 * key-sorted JSON, and simulation stderr summarized (not dumped) before it is
 * ever serialized.
 *
 * The runtime holds the current design + version (a snapshot the conversation
 * runner refreshes from the UI store before each turn), the staged proposals,
 * and the most recent simulation run id (for read_waveform).
 */

import type { ToolSpec } from "../types.js";
import type { EngineHooks } from "./engine.js";
import { gateDesign } from "./validated.js";
import type { StagedProposal } from "./staging.js";
import {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  READ_WAVEFORM_MAX_POINTS,
  type ToolName,
} from "./registry.js";
import {
  capToolResult,
  capString,
  summarizeStderr,
  DEFAULT_RESULT_CHAR_CAP,
} from "./truncate.js";

/** A design snapshot the runtime reasons about (mirrors the UI store). */
export interface DesignSnapshot {
  xml: string;
  /** Monotonic version from the store (proposals stamp their baseVersion). */
  version: number;
}

/** What a tool call did, for the conversation runner + the UI transcript. */
export interface ToolExecution {
  /** The bounded string handed back to the model as the tool result. */
  result: string;
  /** A proposal this call staged (set_design / propose_patch on gate pass). */
  staged?: StagedProposal;
  /** True when the tool ran the deterministic gate and it REJECTED the design. */
  gateRejected?: boolean;
  /** True when the tool aborted because the run's AbortSignal fired. */
  aborted?: boolean;
}

/** Options for a runtime instance. */
export interface ToolRuntimeOptions {
  hooks: EngineHooks;
  /** Per-tool-result char cap (deliverable 4). Defaults to 6000. */
  resultCharCap?: number;
  /** Per-simulation timeout ceiling in ms (run_simulation is capped to this). */
  simTimeoutCeilingMs?: number;
  /** Injectable id source for deterministic proposal ids in tests. */
  idFactory?: () => string;
}

let proposalSeq = 0;
function defaultId(): string {
  proposalSeq += 1;
  return `proposal-${proposalSeq}`;
}

export class ToolRuntime {
  readonly tools: ToolSpec[] = AGENT_TOOLS;

  private readonly hooks: EngineHooks;
  private readonly charCap: number;
  private readonly simCeilingMs: number;
  private readonly newId: () => string;

  private design: DesignSnapshot;
  private readonly proposals: StagedProposal[] = [];
  private lastRunId: string | null = null;

  constructor(initial: DesignSnapshot, opts: ToolRuntimeOptions) {
    this.design = initial;
    this.hooks = opts.hooks;
    this.charCap = opts.resultCharCap ?? DEFAULT_RESULT_CHAR_CAP;
    this.simCeilingMs = opts.simTimeoutCeilingMs ?? 30_000;
    this.newId = opts.idFactory ?? defaultId;
  }

  /** Refresh the design snapshot from the store (before each turn). */
  setDesignSnapshot(snapshot: DesignSnapshot): void {
    this.design = snapshot;
  }

  /** The proposals staged so far this run (for the UI diff list). */
  stagedProposals(): readonly StagedProposal[] {
    return this.proposals;
  }

  /**
   * Execute ONE tool call. `args` are already parsed + shallow-validated by the
   * provider (repair.ts); a name outside the registry is a caller bug (the
   * conversation runner routes unknown tools through the recovery ladder before
   * ever calling here), but we defend anyway.
   *
   * `signal` lets an in-flight simulation be canceled (Stop button).
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    if (!AGENT_TOOL_NAMES.has(name)) {
      return {
        result: capToolResult(
          { error: "unknown_tool", detail: `No such tool: ${name}.` },
          this.charCap,
        ),
      };
    }
    switch (name as ToolName) {
      case "get_design":
        return this.getDesign();
      case "set_design":
        return this.setDesign(args);
      case "validate_design":
        return this.validateDesign(args);
      case "run_simulation":
        return this.runSimulation(args, signal);
      case "propose_patch":
        return this.proposePatch(args);
      case "preview_patch":
        return this.previewPatch(args);
      case "read_waveform":
        return this.readWaveform(args);
      case "list_registry_components":
        return this.listRegistry();
    }
  }

  // ----------------------------------------------------------------------- //
  // Introspection tools.
  // ----------------------------------------------------------------------- //

  private getDesign(): ToolExecution {
    const diagnostics = safeValidate(this.hooks, this.design.xml);
    return {
      result: capToolResult(
        {
          design_xml: capString(this.design.xml, this.charCap - 512),
          version: this.design.version,
          diagnostics,
        },
        this.charCap,
      ),
    };
  }

  private listRegistry(): ToolExecution {
    const listing = this.hooks.listRegistry();
    return { result: capToolResult(listing, this.charCap) };
  }

  private validateDesign(args: Record<string, unknown>): ToolExecution {
    const xml = typeof args["design_xml"] === "string"
      ? (args["design_xml"] as string)
      : this.design.xml;
    const diagnostics = safeValidate(this.hooks, xml);
    const errors = diagnostics.filter((d) => d.severity === "error");
    const warnings = diagnostics.filter((d) => d.severity === "warning");
    return {
      result: capToolResult(
        {
          valid: errors.length === 0,
          error_count: errors.length,
          warning_count: warnings.length,
          // Cap the fed-back lists (agent.py caps at 10) to keep results bounded.
          errors: errors.slice(0, 10),
          warnings: warnings.slice(0, 10),
        },
        this.charCap,
      ),
    };
  }

  // ----------------------------------------------------------------------- //
  // Mutating tools: BOTH run the gate and STAGE; NEITHER writes editor state.
  // ----------------------------------------------------------------------- //

  private setDesign(args: Record<string, unknown>): ToolExecution {
    const designXml = args["design_xml"];
    if (typeof designXml !== "string") {
      return this.badArgs("set_design", "design_xml (string) is required.");
    }
    const summary = typeof args["summary"] === "string" ? (args["summary"] as string) : "";

    // THE GATE. normalize -> validate. A failure is fed back, never applied.
    const gate = gateDesign(designXml, this.hooks);
    if (!gate.ok) {
      return this.gateFailure("set_design", gate.diagnostics, gate.error);
    }
    const proposal: StagedProposal = {
      id: this.newId(),
      summary: summary || "Proposed design",
      validated: gate.design,
      source: { kind: "full", designXml },
      baseVersion: this.design.version,
      diagnostics: gate.design.diagnostics,
    };
    this.proposals.push(proposal);
    return {
      staged: proposal,
      result: capToolResult(
        {
          staged: true,
          proposal_id: proposal.id,
          message:
            "Design passed the gate and is STAGED as a proposal. The user must " +
            "Apply it before it becomes the design; it is not yet applied.",
          warning_count: gate.design.diagnostics.length,
          diagnostics: gate.design.diagnostics.slice(0, 10),
        },
        this.charCap,
      ),
    };
  }

  private proposePatch(args: Record<string, unknown>): ToolExecution {
    const patchXml = args["patch_xml"];
    if (typeof patchXml !== "string") {
      return this.badArgs("propose_patch", "patch_xml (string) is required.");
    }
    const summary = typeof args["summary"] === "string" ? (args["summary"] as string) : "";

    // Apply the patch to the CURRENT design, then run the gate on the result.
    let patchedXml: string;
    try {
      patchedXml = this.hooks.applyPatch(this.design.xml, patchXml);
    } catch (err) {
      // A patch that doesn't apply is a model error fed back (not a crash).
      return {
        gateRejected: true,
        result: capToolResult(
          {
            error: "patch_did_not_apply",
            detail: (err as Error).message,
            hint: "Fix the patch paths/ops and try again. Use preview_patch first.",
          },
          this.charCap,
        ),
      };
    }

    const gate = gateDesign(patchedXml, this.hooks);
    if (!gate.ok) {
      return this.gateFailure("propose_patch", gate.diagnostics, gate.error);
    }
    const proposal: StagedProposal = {
      id: this.newId(),
      summary: summary || "Proposed edit",
      validated: gate.design,
      source: { kind: "patch", patchXml },
      baseVersion: this.design.version,
      diagnostics: gate.design.diagnostics,
    };
    this.proposals.push(proposal);
    return {
      staged: proposal,
      result: capToolResult(
        {
          staged: true,
          proposal_id: proposal.id,
          message:
            "Patch applied and passed the gate; STAGED as a proposal for the " +
            "user to Apply. Not yet applied.",
          warning_count: gate.design.diagnostics.length,
          diagnostics: gate.design.diagnostics.slice(0, 10),
        },
        this.charCap,
      ),
    };
  }

  private previewPatch(args: Record<string, unknown>): ToolExecution {
    const patchXml = args["patch_xml"];
    if (typeof patchXml !== "string") {
      return this.badArgs("preview_patch", "patch_xml (string) is required.");
    }
    try {
      const preview = this.hooks.previewPatch(this.design.xml, patchXml);
      return {
        result: capToolResult(
          {
            success: preview.success,
            operations: preview.operations,
            resolved: preview.resolved,
            introduced: preview.introduced,
            before: preview.before,
            after: preview.after,
          },
          this.charCap,
        ),
      };
    } catch (err) {
      return {
        result: capToolResult(
          { error: "preview_failed", detail: (err as Error).message },
          this.charCap,
        ),
      };
    }
  }

  // ----------------------------------------------------------------------- //
  // Simulation + waveform.
  // ----------------------------------------------------------------------- //

  private async runSimulation(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolExecution> {
    if (signal.aborted) return this.abortedResult();

    // Per-call timeout: min(requested, ceiling). The runtime enforces the
    // ceiling so the model can't ask for an unbounded run.
    const requested = typeof args["timeout_ms"] === "number" ? (args["timeout_ms"] as number) : this.simCeilingMs;
    const timeoutMs = Math.max(1, Math.min(requested, this.simCeilingMs));

    // A local controller lets us cancel on EITHER the run's Stop signal OR the
    // per-call timeout, while forwarding aborts to the engine's simulate.
    const local = new AbortController();
    const onOuterAbort = () => local.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => local.abort(), timeoutMs);

    try {
      const report = await this.hooks.simulate(this.design.xml, local.signal);
      this.lastRunId = report.runId ?? this.lastRunId;
      const notes = report.notes ?? [];
      return {
        result: capToolResult(
          {
            profile: report.profile,
            status: report.status,
            reports: report.reports,
            // stderr / engine notes are already SUMMARIZED at the source; cap
            // again defensively (deliverable 4).
            notes: notes.length ? summarizeStderr(notes) : "",
            run_id: this.lastRunId,
          },
          this.charCap,
        ),
      };
    } catch (err) {
      if (local.signal.aborted) {
        // Distinguish an outer Stop from a timeout for the model + UI.
        const reason = signal.aborted ? "canceled" : "timeout";
        return {
          aborted: signal.aborted,
          result: capToolResult(
            {
              error: `simulation_${reason}`,
              detail:
                reason === "timeout"
                  ? `Simulation exceeded the ${timeoutMs}ms budget and was canceled.`
                  : "Simulation was canceled by the user (Stop).",
            },
            this.charCap,
          ),
        };
      }
      return {
        result: capToolResult(
          { error: "simulation_failed", detail: (err as Error).message },
          this.charCap,
        ),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }

  private readWaveform(args: Record<string, unknown>): ToolExecution {
    const net = args["net"];
    if (typeof net !== "string") {
      return this.badArgs("read_waveform", "net (string) is required.");
    }
    if (!this.lastRunId) {
      return {
        result: capToolResult(
          {
            error: "no_run",
            detail: "No simulation has been run yet; call run_simulation first.",
          },
          this.charCap,
        ),
      };
    }
    const summary = this.hooks.readWaveform(this.lastRunId, net, READ_WAVEFORM_MAX_POINTS);
    if (!summary) {
      return {
        result: capToolResult(
          {
            error: "no_waveform",
            detail: `No probed waveform for net '${net}' in the latest run.`,
          },
          this.charCap,
        ),
      };
    }
    return { result: capToolResult(summary, this.charCap) };
  }

  // ----------------------------------------------------------------------- //
  // Shared result builders.
  // ----------------------------------------------------------------------- //

  private gateFailure(
    tool: string,
    diagnostics: readonly { severity: string; code: string; message: string }[],
    error?: string,
  ): ToolExecution {
    return {
      gateRejected: true,
      result: capToolResult(
        {
          error: "validation_failed",
          tool,
          detail:
            error ??
            "The design did not pass the gate (normalize -> validate). It was " +
              "NOT applied. Fix the errors below and call the tool again.",
          errors: diagnostics.filter((d) => d.severity === "error").slice(0, 12),
        },
        this.charCap,
      ),
    };
  }

  private badArgs(tool: string, detail: string): ToolExecution {
    return {
      result: capToolResult({ error: "bad_arguments", tool, detail }, this.charCap),
    };
  }

  private abortedResult(): ToolExecution {
    return {
      aborted: true,
      result: capToolResult(
        { error: "aborted", detail: "The run was stopped before this tool ran." },
        this.charCap,
      ),
    };
  }
}

/** validate() but never throws — malformed XML yields a single parse error. */
function safeValidate(
  hooks: EngineHooks,
  xml: string,
): { severity: "error" | "warning" | "info"; code: string; message: string }[] {
  try {
    return hooks.validate(xml);
  } catch (err) {
    return [{ severity: "error", code: "XML_PARSE_ERROR", message: (err as Error).message }];
  }
}
