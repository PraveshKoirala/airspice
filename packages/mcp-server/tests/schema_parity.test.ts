/**
 * SCHEMA-PARITY test (issue #40, PRD acceptance: "Tool schemas byte-identical to
 * #18's browser tool schemas").
 *
 * Imports BOTH:
 *   - the #18 browser tool specs  (`AGENT_TOOLS` from `agent`, defined in
 *     packages/agent/src/tools/registry.ts), and
 *   - the MCP server's exported tool definitions (`MCP_TOOLS` from the
 *     side-effect-free `../src/tools.js`),
 * and asserts the MCP schemas are NOT forked from the shared source of truth.
 *
 * WHY NAMES DIFFER (and how parity is still enforced): the browser agent is
 * STATEFUL -- it operates on a session "current design", so its tools take no
 * design argument (run_simulation/propose_patch/list_registry_components). The
 * MCP server is STATELESS -- every tool takes the design XML explicitly. The two
 * therefore cannot share full input schemas. What they MUST share (PRD:
 * "One source of truth for tool schemas", "no forked ... logic") is the
 * definition of the ENGINE parameters: the AIR design-XML parameter and the
 * patch parameter. Those are extracted from the browser specs here and every MCP
 * tool that carries them must reproduce them BYTE-FOR-BYTE.
 *
 * WHY THIS FAILS A FORKING SERVER: if the MCP server rewrites the design-XML or
 * patch parameter's description/type (a fork), or renames/drops a curated tool,
 * or hand-rolls a fresh schema instead of composing the shared spec, the
 * deep-equal / set assertions below fail.
 *
 * BUILDER CONTRACT (assumed -- see the branch report):
 *   packages/mcp-server/src/tools.ts exports
 *       export const MCP_TOOLS: McpToolDef[]
 *   where McpToolDef = { name: string; description: string; inputSchema: object }
 *   (`inputSchema` is the MCP wire field; `parameters` is also accepted). The
 *   module MUST be import-safe (no server startup on import).
 */

import { describe, it, expect } from "vitest";
import { AGENT_TOOLS } from "agent";
// The MCP tool DEFINITIONS module (pure data; no transport side effects).
import { MCP_TOOLS } from "../src/tools.js";

/** The MCP wire field is `inputSchema`; tolerate `parameters` as an alias. */
function schemaOf(tool: any): any {
  return tool?.inputSchema ?? tool?.parameters;
}

function browserSpec(name: string): any {
  const spec = AGENT_TOOLS.find((t) => t.name === name);
  expect(spec, `browser #18 spec '${name}' must exist`).toBeTruthy();
  return spec;
}

function browserProp(toolName: string, propName: string): any {
  const props = browserSpec(toolName).parameters?.properties ?? {};
  const p = props[propName];
  expect(p, `browser spec '${toolName}' must define property '${propName}'`).toBeTruthy();
  return p;
}

function mcpTool(name: string): any {
  const t = (MCP_TOOLS as any[]).find((x) => x.name === name);
  expect(t, `MCP tool '${name}' must be defined in MCP_TOOLS`).toBeTruthy();
  return t;
}

function mcpProp(toolName: string, propName: string): any {
  const schema = schemaOf(mcpTool(toolName));
  expect(schema?.type, `MCP tool '${toolName}' inputSchema must be an object schema`).toBe("object");
  const p = (schema.properties ?? {})[propName];
  expect(p, `MCP tool '${toolName}' must define property '${propName}'`).toBeTruthy();
  return p;
}

// The single source of truth for the engine parameters, taken from #18.
const SHARED_DESIGN_XML = browserProp("validate_design", "design_xml");
const SHARED_PATCH_XML = browserProp("preview_patch", "patch_xml");

// Every MCP tool that accepts a design carries the AIR design-XML parameter.
const DESIGN_TOOLS = [
  "validate_design",
  "simulate",
  "apply_patch",
  "preview_patch",
  "render_schematic",
  "run_cosim",
];
// The patch tools additionally carry the patch parameter.
const PATCH_TOOLS = ["apply_patch", "preview_patch"];

const EXPECTED_MCP_TOOL_NAMES = [
  "validate_design",
  "simulate",
  "apply_patch",
  "preview_patch",
  "render_schematic",
  "get_registry",
  "run_cosim",
];

describe("MCP <-> #18 schema parity", () => {
  it("shared engine parameters exist in the #18 browser specs", () => {
    expect(SHARED_DESIGN_XML).toBeTruthy();
    expect(SHARED_PATCH_XML).toBeTruthy();
    // They must be real JSON-schema fragments, not empty objects.
    expect(SHARED_DESIGN_XML.type).toBe("string");
    expect(SHARED_PATCH_XML.type).toBe("string");
  });

  it("MCP_TOOLS defines exactly the curated MCP surface", () => {
    const names = (MCP_TOOLS as any[]).map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_MCP_TOOL_NAMES].sort());
    // No accidental duplicates.
    expect(new Set(names).size).toBe(names.length);
  });

  it("every MCP tool definition is well-formed (name + description + object schema)", () => {
    for (const t of MCP_TOOLS as any[]) {
      expect(typeof t.name, "tool name").toBe("string");
      expect(typeof t.description, `tool '${t.name}' description`).toBe("string");
      expect(t.description.length, `tool '${t.name}' description non-empty`).toBeGreaterThan(0);
      const schema = schemaOf(t);
      expect(schema?.type, `tool '${t.name}' inputSchema.type`).toBe("object");
      expect(typeof schema.properties, `tool '${t.name}' inputSchema.properties`).toBe("object");
    }
  });

  it("the AIR design-XML parameter is byte-identical to #18 across every design tool", () => {
    for (const name of DESIGN_TOOLS) {
      expect(
        mcpProp(name, "design_xml"),
        `MCP '${name}'.design_xml must equal the shared #18 design_xml schema (no fork)`,
      ).toEqual(SHARED_DESIGN_XML);
    }
  });

  it("the patch parameter is byte-identical to #18 across every patch tool", () => {
    for (const name of PATCH_TOOLS) {
      expect(
        mcpProp(name, "patch_xml"),
        `MCP '${name}'.patch_xml must equal the shared #18 patch_xml schema (no fork)`,
      ).toEqual(SHARED_PATCH_XML);
    }
  });

  it("get_registry exposes a query lookup (registry surface, not a forked engine op)", () => {
    const schema = schemaOf(mcpTool("get_registry"));
    expect(schema?.type).toBe("object");
    // A registry lookup keyed by an optional query string.
    expect(schema.properties).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(schema.properties, "query")).toBe(true);
  });
});
