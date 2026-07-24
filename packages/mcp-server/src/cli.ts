#!/usr/bin/env node
/**
 * `airspice-mcp` entrypoint (issue #40): start the AirSpice MCP server on stdio.
 *
 * An MCP client (Claude Code, Claude Desktop, …) launches this process and
 * speaks JSON-RPC over stdin/stdout. Nothing is printed to stdout except MCP
 * frames (the transport owns stdout); diagnostics go to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAirspiceMcpServer } from "./server.js";

async function main(): Promise<void> {
  const server = createAirspiceMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep running until stdin closes; the transport resolves connect() and then
  // drives the loop off stdin events.
  process.stderr.write("airspice-mcp: ready on stdio\n");
}

main().catch((err: unknown) => {
  process.stderr.write(
    `airspice-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
