/**
 * Public surface of the AirSpice MCP server package (issue #40).
 *
 * Exposes the server factory and the stateless tool catalog for programmatic use
 * and for a schema-parity test: importing `MCP_TOOLS` here (side-effect-free —
 * no transport starts) alongside `AGENT_TOOLS` from `agent` lets a test assert
 * the shared param property sub-schemas (design_xml / patch_xml) are the same
 * byte-identical objects.
 */

export {
  createAirspiceMcpServer,
  cosimAvailableFromEnv,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export { MCP_TOOLS, RUN_COSIM_TOOL_NAME } from "./tools.js";
export { createMcpEngineHooks } from "./engine/hooks.js";
