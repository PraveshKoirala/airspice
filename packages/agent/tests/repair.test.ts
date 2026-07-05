import { describe, it, expect } from "vitest";
import { parseToolArgs, malformedToolResult, schemaRef, AIR_TOOLS } from "../src/index.js";

describe("parseToolArgs: the recovery ladder validation", () => {
  it("accepts valid args and returns the parsed object", () => {
    const r = parseToolArgs("validate_design", '{"design_path":"a.air.xml"}', AIR_TOOLS);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ design_path: "a.air.xml" });
  });

  it("accepts an empty string as no-argument ({}) for a no-arg tool", () => {
    const r = parseToolArgs("list_registry_parts", "", AIR_TOOLS);
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({});
  });

  it("flags invalid JSON (kind=invalid_json)", () => {
    const r = parseToolArgs("validate_design", "{not json", AIR_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.malformed?.kind).toBe("invalid_json");
    expect(r.malformed?.rawArgs).toBe("{not json");
  });

  it("flags an unknown tool and names the valid tools (kind=unknown_tool)", () => {
    const r = parseToolArgs("format_disk", "{}", AIR_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.malformed?.kind).toBe("unknown_tool");
    expect(r.malformed?.detail).toContain("validate_design");
    expect(r.malformed?.detail).toContain("write_firmware_file");
  });

  it("flags a missing required field (kind=schema_mismatch)", () => {
    const r = parseToolArgs("validate_design", "{}", AIR_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.malformed?.kind).toBe("schema_mismatch");
    expect(r.malformed?.detail).toContain("design_path");
    expect(r.malformed?.detail).toContain("tool:validate_design");
  });

  it("flags a top-level type mismatch on a declared field", () => {
    const r = parseToolArgs("validate_design", '{"design_path":42}', AIR_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.malformed?.kind).toBe("schema_mismatch");
  });

  it("rejects a non-object top-level args value", () => {
    const r = parseToolArgs("validate_design", "[1,2,3]", AIR_TOOLS);
    expect(r.ok).toBe(false);
    expect(r.malformed?.kind).toBe("schema_mismatch");
  });

  it("tolerates extra (undeclared) keys", () => {
    const r = parseToolArgs(
      "validate_design",
      '{"design_path":"a.air.xml","extra":true}',
      AIR_TOOLS,
    );
    expect(r.ok).toBe(true);
  });
});

describe("malformedToolResult: the fed-back structured error", () => {
  it("wraps a schema mismatch with error/detail/schema-ref", () => {
    const r = parseToolArgs("validate_design", "{}", AIR_TOOLS);
    const result = malformedToolResult(r.malformed!);
    expect(result.error).toBe("malformed_tool_call");
    expect(result.kind).toBe("schema_mismatch");
    expect(result.expected_schema_ref).toBe("tool:validate_design");
  });

  it("has a null schema ref for an unknown tool", () => {
    const r = parseToolArgs("nope", "{}", AIR_TOOLS);
    const result = malformedToolResult(r.malformed!);
    expect(result.expected_schema_ref).toBeNull();
  });

  it("schemaRef is stable for a spec", () => {
    expect(schemaRef(AIR_TOOLS[0]!)).toBe(`tool:${AIR_TOOLS[0]!.name}`);
  });
});
