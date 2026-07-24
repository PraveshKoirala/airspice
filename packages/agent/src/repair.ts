/**
 * Malformed-tool-call handling: the recovery ladder (issue #17, post-audit
 * amendment) shared by every provider so all four behave identically.
 *
 * The ladder itself (feed one structured error back, abort on the second
 * consecutive malformed emission, surface subdued system notes, increment a
 * counter) is driven by the tool runtime (#18) which owns the turn loop. This
 * module supplies the *provider-side* half that the amendment pins down:
 *   - parse the model's raw argument string,
 *   - validate the tool name against the known tool list,
 *   - validate the arguments against the tool's JSON schema (shallow: required
 *     keys present, no obviously-wrong top-level types),
 *   - and, on any failure, produce the exact `{error, detail, expected_schema_ref}`
 *     structured error-result the amendment specifies, ready to feed back once.
 *
 * Validation is deliberately shallow (required-key + top-level type), matching
 * the Python layer's philosophy: the authoritative gate is normalize -> validate
 * on the design itself (#11/#8), not a full JSON-Schema engine in the hot path.
 * A full validator would balloon the bundle for little gain here.
 */

import type { MalformedToolCall, ToolSpec } from "./types.js";
import { stripMarkdown } from "./tools/truncate.js";

export interface ParsedToolArgs {
  ok: boolean;
  args: Record<string, unknown> | null;
  malformed?: MalformedToolCall;
}

/**
 * Parse + validate a raw tool-call argument string against the declared tools.
 * `rawArgs` is the JSON text the model emitted for the call's arguments.
 *
 * On success: `{ ok: true, args }`.
 * On failure: `{ ok: false, args: null, malformed }` with a `kind` from the
 * taxonomy the settings counter buckets by.
 */
export function parseToolArgs(
  toolName: string,
  rawArgs: string,
  tools: ToolSpec[],
): ParsedToolArgs {
  const spec = tools.find((t) => t.name === toolName);
  if (!spec) {
    return malformed("unknown_tool", rawArgs, unknownToolDetail(toolName, tools));
  }

  let parsed: unknown;
  try {
    const cleaned = stripMarkdown(rawArgs);
    // An empty argument string means "no arguments" -> {}.
    parsed = cleaned === "" ? {} : JSON.parse(cleaned);
  } catch {
    return malformed(
      "invalid_json",
      rawArgs,
      `Arguments for '${toolName}' were not valid JSON.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return malformed(
      "schema_mismatch",
      rawArgs,
      `Arguments for '${toolName}' must be a JSON object.`,
    );
  }

  const args = parsed as Record<string, unknown>;
  const schemaError = validateAgainstSchema(args, spec);
  if (schemaError) {
    return malformed("schema_mismatch", rawArgs, schemaError);
  }

  return { ok: true, args };
}

/** Shallow schema check: required keys present + top-level primitive types. */
function validateAgainstSchema(
  args: Record<string, unknown>,
  spec: ToolSpec,
): string | null {
  const required = spec.parameters.required ?? [];
  const missing = required.filter((k) => !(k in args));
  if (missing.length > 0) {
    return (
      `Arguments for '${spec.name}' are missing required field(s): ` +
      `${missing.join(", ")}. Expected schema: ${schemaRef(spec)}.`
    );
  }
  const props = spec.parameters.properties;
  for (const [k, v] of Object.entries(args)) {
    const declared = props[k];
    if (!declared || typeof declared !== "object") continue; // unknown/extra key: tolerated
    const expectedType = (declared as { type?: unknown }).type;
    if (typeof expectedType !== "string") continue;
    if (!topLevelTypeMatches(expectedType, v)) {
      return (
        `Field '${k}' for '${spec.name}' should be ${expectedType} but got ` +
        `${jsonType(v)}. Expected schema: ${schemaRef(spec)}.`
      );
    }
  }
  return null;
}

function topLevelTypeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      // Unknown/union type declarations are not enforced here.
      return true;
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function malformed(
  kind: MalformedToolCall["kind"],
  rawArgs: string,
  detail: string,
): ParsedToolArgs {
  return { ok: false, args: null, malformed: { kind, rawArgs, detail } };
}

function unknownToolDetail(toolName: string, tools: ToolSpec[]): string {
  const valid = tools.map((t) => t.name).join(", ") || "(none)";
  return `Unknown tool '${toolName}'. Valid tools are: ${valid}.`;
}

/** A stable reference string for a tool's schema (used in the fed-back error). */
export function schemaRef(spec: ToolSpec): string {
  return `tool:${spec.name}`;
}

/**
 * The structured error-result the recovery ladder feeds back to the model
 * exactly once per turn (step 1 of the amendment). The tool runtime (#18) sends
 * this as a `tool` message so the model can correct itself.
 */
export function malformedToolResult(m: MalformedToolCall): {
  error: "malformed_tool_call";
  detail: string;
  expected_schema_ref: string | null;
  kind: MalformedToolCall["kind"];
} {
  return {
    error: "malformed_tool_call",
    detail: m.detail,
    // The ref is embedded in `detail` when a matching tool exists; for unknown
    // tools there is no schema to point at.
    expected_schema_ref: m.kind === "unknown_tool" ? null : extractRef(m.detail),
    kind: m.kind,
  };
}

function extractRef(detail: string): string | null {
  const match = detail.match(/tool:[A-Za-z0-9_]+/);
  return match ? match[0] : null;
}
