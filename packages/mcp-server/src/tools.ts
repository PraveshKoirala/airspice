/**
 * MCP tool catalog (issue #40) — STATELESS semantic tools.
 *
 * A stdio MCP server has no editor session, so the browser agent's session tools
 * (get_design / set_design / read_waveform) are meaningless here and are NOT
 * exposed. Instead the server offers seven semantic, stateless tools: every tool
 * takes the design as a REQUIRED `design_xml` argument (patch tools also require
 * `patch_xml`); there is no server-held "current design".
 *
 * SCHEMA PARITY (one source of truth): the SHARED parameter property sub-schemas
 * — `design_xml` and `patch_xml` — are the byte-identical objects from the #18
 * browser specs (`AGENT_TOOLS`), reused BY REFERENCE (not copied). A schema-
 * parity test importing both `AGENT_TOOLS` and `MCP_TOOLS` sees the same property
 * objects. The tool NAMES and the `required` arrays differ from #18 by design —
 * parity is on the shared property sub-schemas, not on names/required. (`query`
 * and `profile` have no #18 counterpart, so they are defined here.)
 *
 * This module is SIDE-EFFECT-FREE: it imports only `AGENT_TOOLS` (pure data) and
 * an SDK type. Importing it starts no transport and spawns no worker, so a parity
 * test can import `MCP_TOOLS` without launching the server.
 */

import { AGENT_TOOLS } from "agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Pull a parameter property sub-schema from a #18 tool spec (by reference). */
function sharedProp(toolName: string, propName: string): unknown {
  const spec = AGENT_TOOLS.find((t) => t.name === toolName);
  const prop = spec?.parameters.properties?.[propName];
  if (prop === undefined) {
    throw new Error(
      `AirSpice MCP: expected #18 tool '${toolName}' to define property '${propName}'.`,
    );
  }
  return prop;
}

// The SHARED property sub-schemas — the byte-identical #18 objects, by reference:
//  - design_xml: the "one complete AIR <system> document" property (set_design).
//  - patch_xml : the AIR <patch> property from #18's patch tool (propose_patch).
const DESIGN_XML_PROP = sharedProp("set_design", "design_xml");
const PATCH_XML_PROP = sharedProp("propose_patch", "patch_xml");

// MCP-only properties (no #18 counterpart).
const QUERY_PROP = {
  type: "string",
  description:
    "Optional case-insensitive substring filter. When given, only component " +
    "types and MCU parts whose id contains it are returned; omit to list all.",
};
const PROFILE_PROP = {
  type: "string",
  description:
    "Optional simulation-profile id to run. Omit to run the design's default " +
    "ngspice profile.",
};

type InputSchema = Tool["inputSchema"];

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): InputSchema {
  return { type: "object", properties, required } as unknown as InputSchema;
}

/** The name of the firmware co-sim tool (gated in tools/list; see server.ts). */
export const RUN_COSIM_TOOL_NAME = "run_cosim";

/**
 * The seven MCP tools. `MCP_TOOLS` is the full catalog; the server lists the six
 * base tools always and `run_cosim` only under the launch-context gate.
 */
export const MCP_TOOLS: Tool[] = [
  {
    name: "validate_design",
    description:
      "Validate an AIR design and return its diagnostics (errors + warnings) as " +
      "JSON. Requires the complete design as design_xml.",
    inputSchema: objectSchema({ design_xml: DESIGN_XML_PROP }, ["design_xml"]),
  },
  {
    name: "simulate",
    description:
      "Run the design's ngspice simulation and return the report JSON " +
      "(measurements, assertions, convergence). Requires design_xml; pass an " +
      "optional profile id to run a specific profile instead of the default.",
    inputSchema: objectSchema(
      { design_xml: DESIGN_XML_PROP, profile: PROFILE_PROP },
      ["design_xml"],
    ),
  },
  {
    name: "apply_patch",
    description:
      "Apply an AIR <patch> to a design and return the gated patched result. The " +
      "patched design runs the deterministic gate (normalize + validate); on " +
      "success the canonical patched design_xml is returned, on failure the " +
      "diagnostics are returned and nothing is produced. Requires design_xml and " +
      "patch_xml.",
    inputSchema: objectSchema(
      { design_xml: DESIGN_XML_PROP, patch_xml: PATCH_XML_PROP },
      ["design_xml", "patch_xml"],
    ),
  },
  {
    name: "preview_patch",
    description:
      "Preview an AIR <patch> against a design WITHOUT applying it: returns the " +
      "structured op diff and the before/after diagnostic deltas (which errors it " +
      "resolves or introduces). Requires design_xml and patch_xml.",
    inputSchema: objectSchema(
      { design_xml: DESIGN_XML_PROP, patch_xml: PATCH_XML_PROP },
      ["design_xml", "patch_xml"],
    ),
  },
  {
    name: "render_schematic",
    description:
      "Render the design's schematic as a standalone, deterministic SVG string " +
      "(headless). Requires design_xml. Same design in → same SVG bytes out.",
    inputSchema: objectSchema({ design_xml: DESIGN_XML_PROP }, ["design_xml"]),
  },
  {
    name: "get_registry",
    description:
      "List the electronics component types and MCU parts available in the local " +
      "registry. Pass an optional query substring to filter.",
    inputSchema: objectSchema({ query: QUERY_PROP }, []),
  },
  {
    name: RUN_COSIM_TOOL_NAME,
    description:
      "Run firmware ⇄ analog co-simulation for a design that has a <firmware> " +
      "block. The analog domain is solved by real ngspice. NOTE: time-stepped " +
      "firmware EXECUTION requires the MicroPython WASM runtime (issue #37), " +
      "which is not yet available, so this returns the resolved firmware pin " +
      "bindings and the real t=0 analog priming solve, and clearly marks that no " +
      "firmware steps were executed. Requires design_xml. This tool is only " +
      "listed when the server was launched with AIRSPICE_MCP_DESIGN pointing at a " +
      "firmware design.",
    inputSchema: objectSchema({ design_xml: DESIGN_XML_PROP }, ["design_xml"]),
  },
];
