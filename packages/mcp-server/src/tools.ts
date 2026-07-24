/**
 * MCP tool catalog (issue #40).
 *
 * ONE SOURCE OF TRUTH: the eight tools the in-browser agent (#18) exposes are
 * imported VERBATIM from `agent` (`AGENT_TOOLS`) — the MCP server does not
 * redeclare them. Each MCP tool's `inputSchema` is literally the same object as
 * the `ToolSpec.parameters` the browser agent ships (`toMcpTool` passes it
 * through by reference), so the schemas are byte-identical to #18's by
 * construction, not by copy. A schema-parity test importing both surfaces sees
 * the same objects.
 *
 * Two ADDITIVE, MCP-only tools cover engine capabilities the browser agent
 * drives through the UI rather than as chat tools:
 *   - `render_schematic` — a headless SVG of the schematic-graph (air-ts
 *     `emitSchematicSvg`; the browser uses its interactive ELK canvas instead).
 *   - `run_cosim`        — firmware ⇄ analog co-sim (sim-wasm CoSimOrchestrator);
 *     listed only when the working design has a <firmware> block.
 * These are NOT part of the #18 parity set (the browser has no equivalent);
 * they are plain schema declarations here, and their handlers delegate all logic
 * to the engine packages (air-ts / sim-wasm) — no logic lives in this file.
 */

import { AGENT_TOOLS, AGENT_TOOL_NAMES } from "agent";
import type { ToolSpec } from "agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export { AGENT_TOOLS, AGENT_TOOL_NAMES };

/** MCP-only: render the schematic-graph to a deterministic, headless SVG. */
export const RENDER_SCHEMATIC_TOOL: ToolSpec = {
  name: "render_schematic",
  description:
    "Render the design's schematic as a standalone SVG string (deterministic, " +
    "headless). Pass design_xml to render a candidate, or omit it to render the " +
    "current working design. Returns the SVG document text.",
  parameters: {
    type: "object",
    properties: {
      design_xml: {
        type: "string",
        description:
          "The AIR XML to render. Omit to render the current working design.",
      },
    },
    required: [],
  },
};

/** MCP-only: firmware ⇄ analog co-simulation over the current working design. */
export const RUN_COSIM_TOOL: ToolSpec = {
  name: "run_cosim",
  description:
    "Run firmware ⇄ analog co-simulation for a design that has a <firmware> " +
    "block. Wraps the quasi-static co-sim orchestrator: the analog domain is " +
    "solved by real ngspice. NOTE: time-stepped firmware EXECUTION requires the " +
    "MicroPython WASM runtime (issue #37), which is not yet available, so this " +
    "returns the resolved firmware pin bindings and the real t=0 analog priming " +
    "solve, and clearly marks that no firmware steps were executed. This tool is " +
    "only listed when the current working design contains a <firmware> block.",
  parameters: {
    type: "object",
    properties: {
      design_xml: {
        type: "string",
        description:
          "The AIR XML to co-simulate. Omit to use the current working design.",
      },
    },
    required: [],
  },
};

/** The additive MCP-only tools (NOT part of the #18 parity set). */
export const MCP_EXTRA_TOOLS: readonly ToolSpec[] = [
  RENDER_SCHEMATIC_TOOL,
  RUN_COSIM_TOOL,
];

/** The full catalog of tool specs this server can expose. */
export const MCP_TOOL_SPECS: readonly ToolSpec[] = [...AGENT_TOOLS, ...MCP_EXTRA_TOOLS];

/**
 * Map a `ToolSpec` to an MCP `Tool`. `inputSchema` is the SAME object as
 * `spec.parameters` (no clone, no transform) so schemas stay byte-identical to
 * the source specs.
 */
export function toMcpTool(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters as unknown as Tool["inputSchema"],
  };
}

/** The full catalog as MCP `Tool` definitions (for tests / introspection). */
export const MCP_TOOL_DEFINITIONS: Tool[] = MCP_TOOL_SPECS.map(toMcpTool);
