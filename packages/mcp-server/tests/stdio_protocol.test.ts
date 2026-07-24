/**
 * STDIO PROTOCOL test (issue #40, PRD deliverable 5 / "tests the tester authors").
 *
 * Spawns the BUILT mcp-server as a Node child process and speaks REAL MCP over
 * stdio: `initialize` -> `notifications/initialized` -> `tools/list` ->
 * `tools/call`. It asserts:
 *
 *  1. `tools/list` advertises EXACTLY the curated MCP surface -- the six base
 *     tools for a non-firmware design, and additionally `run_cosim` for a
 *     firmware design. (This rejects the naive prior-art approach of dumping the
 *     browser agent's stateful session tools -- get_design/set_design/
 *     read_waveform -- over MCP.)
 *  2. `validate_design`'s diagnostics EQUAL air-ts's own `validate()` output for
 *     the same design XML, for BOTH a failing design (non-empty errors) and a
 *     valid design (empty). Expected diagnostics are computed by importing
 *     air-ts directly -- so a server that forks the validator or returns canned
 *     diagnostics fails.
 *
 * WHY THIS FAILS A CANNED/FORKED SERVER:
 *  - A server returning canned `[]` passes the valid case but FAILS the failing
 *    case (which must contain MISSING_GROUND et al.).
 *  - A server returning any fixed diagnostic set FAILS the valid case (expects
 *    `[]`) and/or the deep-equal against air-ts's exact codes/ids/messages.
 *  - A server that re-implements validation with any drift fails the deep-equal.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { validate } from "air-ts";
import {
  McpStdioClient,
  resolveServerEntry,
  DESIGN_ENV,
  type JsonRpcResponse,
} from "./helpers/mcpClient.js";
import { DESIGNS, designXml, designInputPath } from "./helpers/corpus.js";

/** The curated MCP tool surface (PRD #40 deliverable 2). */
const BASE_TOOLS = [
  "validate_design",
  "simulate",
  "apply_patch",
  "preview_patch",
  "render_schematic",
  "get_registry",
];
const COSIM_TOOL = "run_cosim";

function toolNames(list: JsonRpcResponse): string[] {
  expect(list.error, `tools/list errored: ${JSON.stringify(list.error)}`).toBeUndefined();
  const tools = list.result?.tools;
  expect(Array.isArray(tools), "tools/list result.tools must be an array").toBe(true);
  return (tools as Array<{ name: string }>).map((t) => t.name).sort();
}

/**
 * Pull the diagnostics array out of a `tools/call validate_design` result. The
 * text content is JSON: either the `{ success, diagnostics }` payload air-ts
 * serializes, or a bare diagnostics array. Both are accepted; the array is
 * returned for a deep-equal against air-ts's own output.
 */
function extractDiagnostics(res: JsonRpcResponse): any[] {
  expect(res.error, `tools/call errored: ${JSON.stringify(res.error)}`).toBeUndefined();
  const result = res.result;
  expect(result?.isError, "validate_design must not be an MCP error").toBeFalsy();
  const content = result?.content;
  expect(Array.isArray(content), "tool result.content must be an array").toBe(true);
  const textPart = (content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === "text" && typeof c.text === "string",
  );
  expect(textPart, "validate_design must return a text content block").toBeTruthy();
  const payload = JSON.parse(textPart!.text as string);
  const diags = Array.isArray(payload) ? payload : payload.diagnostics;
  expect(Array.isArray(diags), "diagnostics must be an array").toBe(true);
  return diags;
}

describe("MCP stdio protocol", () => {
  let entry: string;
  beforeAll(() => {
    entry = resolveServerEntry();
  }, 180000);

  it("initialize handshake returns protocol + server info", async () => {
    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.VALID),
    });
    try {
      const init = await client.initialize();
      expect(init.error).toBeUndefined();
      expect(init.result?.protocolVersion, "initialize must echo a protocolVersion").toBeTruthy();
      expect(init.result?.serverInfo?.name, "initialize must return serverInfo.name").toBeTruthy();
    } finally {
      await client.close();
    }
  });

  it("tools/list advertises exactly the base tools (no run_cosim) for a NON-firmware design", async () => {
    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.VALID),
    });
    try {
      await client.initialize();
      const names = toolNames(await client.listTools());
      expect(names).toEqual([...BASE_TOOLS].sort());
      expect(names).not.toContain(COSIM_TOOL);
    } finally {
      await client.close();
    }
  });

  it("tools/list additionally advertises run_cosim for a FIRMWARE design", async () => {
    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.FIRMWARE),
    });
    try {
      await client.initialize();
      const names = toolNames(await client.listTools());
      expect(names).toEqual([...BASE_TOOLS, COSIM_TOOL].sort());
    } finally {
      await client.close();
    }
  });

  it("validate_design diagnostics EQUAL air-ts validate() for a FAILING design", async () => {
    const xml = designXml(DESIGNS.FAILING);
    // The expected, computed by importing the real engine directly.
    const expected = JSON.parse(JSON.stringify(validate(xml)));
    expect(expected.length, "sanity: the failing design must produce diagnostics").toBeGreaterThan(0);

    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.FAILING),
    });
    try {
      await client.initialize();
      const res = await client.callTool("validate_design", { design_xml: xml });
      const diags = extractDiagnostics(res);
      expect(diags).toEqual(expected);
    } finally {
      await client.close();
    }
  });

  it("validate_design diagnostics EQUAL air-ts validate() (empty) for a VALID design", async () => {
    const xml = designXml(DESIGNS.VALID);
    const expected = JSON.parse(JSON.stringify(validate(xml)));
    expect(expected, "sanity: the valid design must validate clean").toEqual([]);

    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.VALID),
    });
    try {
      await client.initialize();
      const res = await client.callTool("validate_design", { design_xml: xml });
      const diags = extractDiagnostics(res);
      expect(diags).toEqual(expected);
    } finally {
      await client.close();
    }
  });
});
