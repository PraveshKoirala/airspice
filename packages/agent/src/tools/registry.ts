/**
 * Browser agent tool registry (issue #18 deliverable 1): JSON-schema tool specs
 * the model may call, executed client-side against air-ts (#8/#11/#14) + sim-wasm
 * (#13) by the tool runtime (runtime.ts).
 *
 * PROVENANCE: the shapes reuse `agent.py`/`prompts.py` conventions so the ported
 * prompts (prompts.ts) keep matching the tool surface the model was tuned
 * against. The names `validate_design` and `list_registry_*` come straight from
 * agent.py's `AIR_TOOLS`. The browser adds the closed-loop tools the Python
 * layer expressed as separate CLI entry points (generate/edit/repair/simulate/
 * patch-preview) rather than chat tools — here they become first-class tools so
 * the in-browser agent drives the whole loop through tool calls:
 *
 *   get_design / set_design      — read the current design / STAGE a proposal
 *                                  (set = normalize -> validate -> stage, NEVER
 *                                  a direct write; agent.py run_ai_generate's
 *                                  gate, made explicit as a tool).
 *   validate_design              — diagnostics JSON (agent.py validate_design).
 *   run_simulation               — report JSON (#14 schema) + budgeted timeout.
 *   propose_patch / preview_patch— structured AIR <patch> diff (agent.py
 *                                  run_ai_edit / service.patch_preview, #11).
 *   read_waveform                — DECIMATED summary (max N points).
 *   list_registry_components     — agent.py list_registry_parts (#8 registry).
 *
 * These are DATA (no handlers) — the runtime owns execution so the same specs
 * feed every provider's tool-definition mapping (Anthropic/OpenAI/Gemini/Mock).
 */

import type { ToolSpec } from "../types.js";

/** Tool name string-literal union — the runtime's dispatch keys. */
export type ToolName =
  | "get_design"
  | "set_design"
  | "validate_design"
  | "run_simulation"
  | "propose_patch"
  | "preview_patch"
  | "read_waveform"
  | "list_registry_components";

/** The default cap (max returned points) for `read_waveform` decimation. */
export const READ_WAVEFORM_MAX_POINTS = 256;

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "get_design",
    description:
      "Return the current design as AIR XML plus its live validation " +
      "diagnostics. Call this before editing so you work from the exact " +
      "current document.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_design",
    description:
      "Stage a COMPLETE new AIR <system> design as a proposal. The design is " +
      "normalized and validated (the deterministic gate); if it fails, you " +
      "receive the diagnostics as the result and NOTHING is applied — fix them " +
      "and call again. If it passes, the proposal is staged for the user to " +
      "Apply or Reject (it is NOT written directly). Use for a new design or a " +
      "full rewrite; prefer propose_patch for small edits.",
    parameters: {
      type: "object",
      properties: {
        design_xml: {
          type: "string",
          description: "One complete AIR <system>...</system> document.",
        },
        summary: {
          type: "string",
          description: "A 1-2 sentence description of the design/change.",
        },
      },
      required: ["design_xml"],
    },
  },
  {
    name: "validate_design",
    description:
      "Validate AIR XML and return errors/warnings as diagnostics JSON. Pass " +
      "design_xml to check a candidate, or omit it to validate the current " +
      "design.",
    parameters: {
      type: "object",
      properties: {
        design_xml: {
          type: "string",
          description:
            "The AIR XML to validate. Omit to validate the current design.",
        },
      },
      required: [],
    },
  },
  {
    name: "run_simulation",
    description:
      "Run the current design's default ngspice profile in the browser and " +
      "return the simulation report JSON (measurements, assertions, " +
      "convergence). Bounded by a per-call timeout and the run's budget. " +
      "Simulate only a design that already validates.",
    parameters: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description:
            "Optional per-call timeout in milliseconds (the run is canceled " +
            "if exceeded). Capped by the runtime.",
        },
      },
      required: [],
    },
  },
  {
    name: "propose_patch",
    description:
      "Stage a SMALL edit to the current design as an AIR <patch> diff. Every " +
      "operation element REQUIRES a path attribute (ElementTree-style XPath, " +
      'e.g. .//component[@id=\'R1\']/value). Format: <patch><reason>why</reason>' +
      "<replace path=\"...\"><newElement.../></replace>" +
      "<add path=\"...parent...\"><childToAppend.../></add>" +
      "<remove path=\"...\"/></patch>. " +
      "<replace> swaps the matched element for the payload; <add> appends the " +
      "payload inside the matched parent; <remove> deletes the matched element. " +
      "The patched design then runs the gate (normalize + validate); on failure " +
      "you receive diagnostics and nothing is applied. On success the resulting " +
      "design is staged as a proposal for Apply/Reject. Cheaper than set_design " +
      "for targeted changes.",
    parameters: {
      type: "object",
      properties: {
        patch_xml: {
          type: "string",
          description:
            "An AIR <patch> document whose replace/add/remove children each " +
            "carry a path attribute.",
        },
        summary: {
          type: "string",
          description: "A short description of what the patch changes.",
        },
      },
      required: ["patch_xml"],
    },
  },
  {
    name: "preview_patch",
    description:
      "Preview an AIR <patch> against the current design WITHOUT staging it: " +
      "returns the structured op diff and the before/after diagnostic deltas " +
      "(which errors it resolves or introduces). Same <patch> format as " +
      "propose_patch (each op needs a path attribute). Use to check a patch " +
      "before propose_patch.",
    parameters: {
      type: "object",
      properties: {
        patch_xml: {
          type: "string",
          description: "An AIR <patch>...</patch> diff document to preview.",
        },
      },
      required: ["patch_xml"],
    },
  },
  {
    name: "read_waveform",
    description:
      "Read a DECIMATED summary of a probed net's waveform from the most " +
      "recent simulation run (at most a few hundred points, plus final/min/max " +
      "scalars). You do NOT get raw samples — the summary is enough to reason " +
      "about the signal.",
    parameters: {
      type: "object",
      properties: {
        net: {
          type: "string",
          description: "The net id whose waveform to summarize.",
        },
        test: {
          type: "string",
          description:
            "Optional test id (defaults to the first test that probed the net).",
        },
      },
      required: ["net"],
    },
  },
  {
    name: "list_registry_components",
    description:
      "List the electronics component types and MCU parts available in the " +
      "local registry. Use to confirm a part/type name exists before using it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

/** The tool names as a set, for O(1) validity checks in the runtime. */
export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOLS.map((t) => t.name),
);
