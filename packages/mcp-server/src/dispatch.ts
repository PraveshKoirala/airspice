/**
 * Stateless tool dispatch (issue #40).
 *
 * Each handler is a THIN wrapper over the engine packages — it reads the
 * required arguments and delegates: validation/normalize/patch/registry to
 * air-ts through the EngineHooks seam, gating to the agent's `gateDesign` (the
 * one deterministic gate, unforked), simulation to the sim-wasm Node pipeline,
 * the schematic to air-ts's headless SVG emitter, and co-sim to the sim-wasm
 * orchestrator wrapper. No validation / simulation / patch / render logic is
 * reimplemented here; there is no server state.
 */

import { gateDesign } from "agent";
import type { EngineHooks, GateDiagnostic } from "agent";
import { toSchematicSvg } from "air-ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { simulateDesign } from "./engine/simulate.js";
import { runCosim } from "./cosim.js";

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing required '${key}' (a non-empty string) argument.`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** validate() but never throws — malformed XML yields one parse-error diag. */
function safeValidate(hooks: EngineHooks, xml: string): GateDiagnostic[] {
  try {
    return hooks.validate(xml);
  } catch (err) {
    return [
      {
        severity: "error",
        code: "XML_PARSE_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }
}

/**
 * Execute one MCP tool call statelessly. `hooks` is the air-ts/sim-wasm engine
 * seam; `signal` cancels an in-flight simulation.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  hooks: EngineHooks,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "validate_design": {
        const xml = requireString(args, "design_xml");
        // The FULL air-ts validate() output, all severities, oracle order,
        // unfiltered — exactly what a consumer gets from air-ts validate().
        const diagnostics = safeValidate(hooks, xml);
        const errors = diagnostics.filter((d) => d.severity === "error");
        const warnings = diagnostics.filter((d) => d.severity === "warning");
        return jsonResult({
          valid: errors.length === 0,
          error_count: errors.length,
          warning_count: warnings.length,
          diagnostics,
          errors,
          warnings,
        });
      }

      case "simulate": {
        const xml = requireString(args, "design_xml");
        const profile = optionalString(args, "profile");
        const report = await simulateDesign(xml, signal, profile);
        return jsonResult({
          profile: report.profile,
          status: report.status,
          reports: report.reports,
          notes: report.notes,
        });
      }

      case "apply_patch": {
        const xml = requireString(args, "design_xml");
        const patch = requireString(args, "patch_xml");
        let patched: string;
        try {
          patched = hooks.applyPatch(xml, patch);
        } catch (err) {
          return jsonResult({
            applied: false,
            error: "patch_did_not_apply",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        const gate = gateDesign(patched, hooks);
        if (!gate.ok) {
          return jsonResult({
            applied: false,
            error: "validation_failed",
            errors: gate.diagnostics.filter((d) => d.severity === "error"),
          });
        }
        return jsonResult({
          applied: true,
          design_xml: gate.design.xml,
          diagnostics: gate.design.diagnostics,
        });
      }

      case "preview_patch": {
        const xml = requireString(args, "design_xml");
        const patch = requireString(args, "patch_xml");
        try {
          const p = hooks.previewPatch(xml, patch);
          return jsonResult({
            success: p.success,
            operations: p.operations,
            resolved: p.resolved,
            introduced: p.introduced,
            before: p.before,
            after: p.after,
          });
        } catch (err) {
          return jsonResult({
            error: "preview_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      case "render_schematic": {
        const xml = requireString(args, "design_xml");
        return textResult(toSchematicSvg(xml));
      }

      case "get_registry": {
        const query = optionalString(args, "query");
        const { components, mcus } = hooks.listRegistry();
        if (query === undefined) {
          return jsonResult({ query: null, components, mcus });
        }
        const q = query.toLowerCase();
        return jsonResult({
          query,
          components: components.filter((c) => c.toLowerCase().includes(q)),
          mcus: mcus.filter((m) => m.toLowerCase().includes(q)),
        });
      }

      case "run_cosim": {
        const xml = requireString(args, "design_xml");
        const result = await runCosim(xml, signal);
        return jsonResult(result);
      }

      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}
