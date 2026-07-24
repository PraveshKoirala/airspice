/**
 * AirSpice MCP server (issue #40): transport + wiring ONLY.
 *
 * Responsibilities, in full:
 *   1. Advertise the tool catalog (the #18 tools verbatim + render_schematic,
 *      and run_cosim only when the working design has firmware).
 *   2. Route `tools/call` to the SAME agent `ToolRuntime` the browser uses for
 *      the #18 tools (so validation / patch / simulate / registry all run the
 *      one code path), and to air-ts / the cosim wrapper for the two extras.
 *   3. Hold the "working design": the browser's editor state is here replaced by
 *      an in-process snapshot. set_design / propose_patch stage a gated proposal
 *      (the runtime's single write path is untouched); this server then ADOPTS
 *      the gated result as the working design — the headless equivalent of the
 *      user clicking Apply — so subsequent stateful tools (run_simulation,
 *      get_design, propose_patch, render_schematic, run_cosim) operate on it.
 *
 * NO engine logic lives here. Validation/normalize/patch/registry come from
 * air-ts via the EngineHooks seam; simulation from sim-wasm's worker; the SVG
 * from air-ts; co-sim from sim-wasm's orchestrator. This file wires those to the
 * MCP wire protocol and manages the working-design snapshot — nothing more.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRuntime, AGENT_TOOL_NAMES } from "agent";
import type { DesignSnapshot, EngineHooks, StagedProposal } from "agent";
import { parse, toSchematicSvg } from "air-ts";
import {
  AGENT_TOOLS,
  RENDER_SCHEMATIC_TOOL,
  RUN_COSIM_TOOL,
  toMcpTool,
} from "./tools.js";
import { createMcpEngineHooks } from "./engine/hooks.js";
import { runCosim, hasFirmware } from "./cosim.js";

export const SERVER_NAME = "airspice";
export const SERVER_VERSION = "0.1.0";

/** True when `xml` parses to a design that declares a firmware project. */
function detectFirmware(xml: string): boolean {
  if (!xml.trim()) return false;
  try {
    return hasFirmware(parse(xml));
  } catch {
    return false;
  }
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Construct the AirSpice MCP `Server`. `hooks` is injectable so tests can supply
 * a deterministic engine; the default wires the real air-ts + sim-wasm engine.
 */
export function createAirspiceMcpServer(
  hooks: EngineHooks = createMcpEngineHooks(),
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  // The working design (headless replacement for the browser's editor state).
  let design: DesignSnapshot = { xml: "", version: 0 };
  let currentHasFirmware = false;
  const runtime = new ToolRuntime(design, { hooks });

  /** Update the working design everywhere and fire tools/list_changed if the
   *  firmware-presence (which gates run_cosim's visibility) flipped. */
  function setDesign(next: DesignSnapshot): void {
    design = next;
    runtime.setDesignSnapshot(next);
    const nextHasFirmware = detectFirmware(next.xml);
    if (nextHasFirmware !== currentHasFirmware) {
      currentHasFirmware = nextHasFirmware;
      void server.sendToolListChanged();
    }
  }

  /** Adopt a gated proposal as the working design (the "Apply" equivalent). */
  function adopt(proposal: StagedProposal): void {
    setDesign({ xml: proposal.validated.xml, version: design.version + 1 });
  }

  /** design_xml arg if provided, else the current working design; else throw. */
  function resolveXml(args: Record<string, unknown>): string {
    const provided = args["design_xml"];
    if (typeof provided === "string" && provided.trim()) return provided;
    if (design.xml.trim()) return design.xml;
    throw new Error(
      "No design available: pass design_xml, or stage one with set_design first.",
    );
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = AGENT_TOOLS.map(toMcpTool);
    tools.push(toMcpTool(RENDER_SCHEMATIC_TOOL));
    if (currentHasFirmware) tools.push(toMcpTool(RUN_COSIM_TOOL));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    try {
      if (AGENT_TOOL_NAMES.has(name)) {
        const exec = await runtime.execute(name, args, controller.signal);
        if (exec.staged) adopt(exec.staged);
        return textResult(exec.result);
      }
      if (name === RENDER_SCHEMATIC_TOOL.name) {
        return textResult(toSchematicSvg(resolveXml(args)));
      }
      if (name === RUN_COSIM_TOOL.name) {
        const result = await runCosim(resolveXml(args), controller.signal);
        return textResult(JSON.stringify(result, null, 2));
      }
      return errorResult(`Unknown tool: ${name}`);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}
