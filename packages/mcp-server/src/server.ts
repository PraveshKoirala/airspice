/**
 * AirSpice MCP server (issue #40): transport + wiring ONLY.
 *
 * The server is STATELESS: there is no "current design". `tools/list` advertises
 * the six base semantic tools, plus `run_cosim` ONLY under the launch-context
 * gate (env `AIRSPICE_MCP_DESIGN` points at an AIR XML file that has a
 * <firmware> block). `tools/call` routes to the stateless dispatch, which is a
 * thin wrapper over the engine packages.
 *
 * No engine logic lives here: validation/normalize/patch/registry come from
 * air-ts via the EngineHooks seam, simulation from sim-wasm's worker, the SVG
 * from air-ts, co-sim from sim-wasm's orchestrator. This file wires those to the
 * MCP wire protocol — nothing more.
 */

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { EngineHooks } from "agent";
import { parse } from "air-ts";
import { MCP_TOOLS, RUN_COSIM_TOOL_NAME } from "./tools.js";
import { createMcpEngineHooks } from "./engine/hooks.js";
import { callTool } from "./dispatch.js";
import { hasFirmware } from "./cosim.js";

export const SERVER_NAME = "airspice";
export const SERVER_VERSION = "0.1.0";

/**
 * Launch-context gate for `run_cosim`: true when env `AIRSPICE_MCP_DESIGN`
 * points at a readable AIR XML file whose design declares a <firmware> block.
 * Read once at launch — this is not runtime state, it reflects how the client
 * configured the server. Any read/parse failure means "not available" (the tool
 * is simply not listed).
 */
export function cosimAvailableFromEnv(): boolean {
  const path = process.env["AIRSPICE_MCP_DESIGN"];
  if (!path || !path.trim()) return false;
  try {
    return hasFirmware(parse(readFileSync(path, "utf8")));
  } catch {
    return false;
  }
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
    { capabilities: { tools: {} } },
  );

  // The advertised tool list, fixed at launch: the six base tools always, plus
  // run_cosim only under the launch-context gate.
  const cosimAvailable = cosimAvailableFromEnv();
  const listedTools = MCP_TOOLS.filter(
    (t) => t.name !== RUN_COSIM_TOOL_NAME || cosimAvailable,
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Enforce the same launch-context gate on calls as on listing, so an
    // ungated run_cosim call is rejected rather than silently executed.
    if (request.params.name === RUN_COSIM_TOOL_NAME && !cosimAvailable) {
      return {
        content: [
          {
            type: "text",
            text:
              "run_cosim is not available: launch the server with " +
              "AIRSPICE_MCP_DESIGN pointing at an AIR design that has a " +
              "<firmware> block.",
          },
        ],
        isError: true,
      };
    }
    const controller = new AbortController();
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return callTool(request.params.name, args, hooks, controller.signal);
  });

  return server;
}
