/**
 * Public surface of the AirSpice MCP server package (issue #40).
 *
 * Exposes the server factory and the tool catalog for programmatic use and for
 * a schema-parity test (importing both the #18 browser specs and these MCP tool
 * definitions and asserting the shared tools are byte-identical).
 */

export { createAirspiceMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
export {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  MCP_EXTRA_TOOLS,
  MCP_TOOL_SPECS,
  MCP_TOOL_DEFINITIONS,
  RENDER_SCHEMATIC_TOOL,
  RUN_COSIM_TOOL,
  toMcpTool,
} from "./tools.js";
export { createMcpEngineHooks } from "./engine/hooks.js";
