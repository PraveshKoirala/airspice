/**
 * AIR agent tool specs, ported from the Python `AIR_TOOLS` list in
 * `packages/core/src/air/agent.py`. Same names + descriptions so ported prompts
 * (M3) and the mock provider's canned sequences keep matching what the model was
 * tuned against. Parameter schemas are the browser-side declaration; the actual
 * tool *execution* against the in-browser engine is issue #18.
 *
 * PROVENANCE: names/descriptions mirror agent.py's AIR_TOOLS (get_capabilities,
 * list_registry_parts, validate_design, run_design_check, read_documentation,
 * write_firmware_file). Keep in sync if the Python list changes.
 */

import type { ToolSpec } from "./types.js";

export const AIR_TOOLS: ToolSpec[] = [
  {
    name: "get_capabilities",
    description: "Inquire what the AINativeSPice platform can do.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_registry_parts",
    description: "List electronics parts and MCUs in the local registry.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "validate_design",
    description: "Validate an .air.xml design file and return errors/warnings.",
    parameters: {
      type: "object",
      properties: {
        design_path: {
          type: "string",
          description: "Path to the .air.xml design to validate.",
        },
      },
      required: ["design_path"],
    },
  },
  {
    name: "run_design_check",
    description: "Run full validation + simulation on an .air.xml design.",
    parameters: {
      type: "object",
      properties: {
        design_path: {
          type: "string",
          description: "Path to the .air.xml design to check.",
        },
        out_dir: {
          type: "string",
          description: "Output directory for the run's artifacts.",
        },
      },
      required: ["design_path"],
    },
  },
  {
    name: "read_documentation",
    description: "Read internal docs (e.g. 'AIR_SPECIFICATION.md').",
    parameters: {
      type: "object",
      properties: {
        doc_name: {
          type: "string",
          description: "Documentation file name under docs/.",
        },
      },
      required: ["doc_name"],
    },
  },
  {
    name: "write_firmware_file",
    description: "Create/update C++ firmware source or headers.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Target path under a 'firmware/' directory.",
        },
        content: { type: "string", description: "File contents to write." },
      },
      required: ["path", "content"],
    },
  },
];
