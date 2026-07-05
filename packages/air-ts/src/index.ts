/**
 * air-ts public facade (epic #6: the UI/engine consume air-ts through ONE
 * entry point). Issue #7 surface: parse XML to the typed model, serialize the
 * model to byte-exact `model.json`, and canonicalize to byte-exact
 * `canonical.air.xml`.
 *
 * Zero DOM/React dependency; safe in browser, Web Worker, and Node.
 */

import { parseXml, type XmlElement } from "./xml.js";
import { parseTree } from "./parser.js";
import { canonicalizeTree } from "./canonicalizer.js";
import { serializeModel } from "./model_dump.js";
import type { SystemIR } from "./model.js";
import { validateAll, serializeDiagnostics as serializeDiagnosticsList } from "./validate/index.js";
import type { Diagnostic } from "./validate/index.js";
import { buildGraphData, serializeGraph as serializeGraphIr, type GraphData } from "./emit/graph.js";

/**
 * Parse AIR XML into the typed SystemIR model.
 *
 * Mirrors the oracle's `parse_string`: the model is built from a normalized
 * clone of the tree, while the raw tree is what `canonicalize` consumes.
 */
export function parse(xmlText: string): SystemIR {
  const root = parseXml(xmlText);
  return parseTree(root);
}

/**
 * Canonicalize AIR XML to the byte-exact canonical form.
 *
 * PARITY: canonicalization runs on the RAW (un-normalized) tree, exactly like
 * the exporter (`canonicalize_tree(tree)` where `tree` is the original parsed
 * tree). Comments are already dropped at parse time (ElementTree semantics).
 */
export function canonicalize(xmlText: string): string {
  const root = parseXml(xmlText);
  return canonicalizeTree(root);
}

/**
 * Parse a pre-built raw element tree (advanced/testing use). Also exposes the
 * split so #9/#10 can share one parse of the raw tree for both model and
 * canonical outputs.
 */
export function parseRawTree(root: XmlElement): SystemIR {
  return parseTree(root);
}

/**
 * Validate AIR XML: parse once, then run the oracle's
 * `validate_tree(tree) + validate_ir(ir)` over the raw tree and typed model.
 * Returns the ordered diagnostics list (empty === no findings).
 *
 * PARITY: validation runs on the RAW tree for schema checks and the parsed
 * model for semantic/electrical checks, exactly like export_golden.py
 * (`ir, tree = parse_file(...)` then `validate_tree(tree) + validate_ir(ir)`).
 */
export function validate(xmlText: string): Diagnostic[] {
  const root = parseXml(xmlText);
  const ir = parseTree(root);
  return validateAll(root, ir);
}

/**
 * Validate and serialize to the byte-exact `diagnostics.json` string (with the
 * `success` flag and trailing newline), matching the golden corpus fixture.
 */
export function validateToJson(xmlText: string): string {
  return serializeDiagnosticsList(validate(xmlText));
}

/**
 * Parse AIR XML and build the schematic-graph payload (`{ nodes, edges }`) the
 * UI's Schematic tab renders -- the local, in-process replacement for the
 * backend's `POST /graph`. Mirrors the oracle: `parse_string(xml)` then
 * `build_graph_data(ir)`.
 */
export function toGraph(xmlText: string): GraphData {
  const root = parseXml(xmlText);
  const ir = parseTree(root);
  return buildGraphData(ir);
}

/**
 * Parse AIR XML and serialize to the byte-exact `graph.json` string (trailing
 * newline included), matching the golden-corpus fixture.
 */
export function toGraphJson(xmlText: string): string {
  const root = parseXml(xmlText);
  const ir = parseTree(root);
  return serializeGraphIr(ir);
}

export { parseXml };
export { serializeModel };
export { canonicalizeTree };

// Graph emitter surface (issue #10): the schematic-graph the UI renders, plus
// its byte-exact serializer for parity.
export { buildGraphData, serializeGraph, inferNetRole } from "./emit/graph.js";
export type { GraphData } from "./emit/graph.js";

// Validation surface (issue #8): the diagnostics contract the agent layer trusts.
export {
  validateAll,
  validateTree,
  validateIr,
  buildTreeSchemaView,
  buildDiagnosticsPayload,
  serializeDiagnostics,
  hasErrors,
} from "./validate/index.js";
export type { Diagnostic, Severity, TreeSchemaView } from "./validate/index.js";

// Registry surface (compiled from registry/ at build time; no runtime fetch).
export {
  MCUS,
  COMPONENT_SPECS,
  PASSIVE_TYPES,
  SUPPORTED_SPICE_TYPES,
  BUILTIN_SPICE_MODELS,
  BUILTIN_SPICE_SUBCKTS,
} from "./registry/index.js";
export type { ComponentSpec, McuSpec, PeripheralSpec } from "./registry/index.js";

// Re-export the typed model so consumers get the schema types from the facade.
export type * from "./model.js";

// Units + number formatting are part of the engine's public surface and are
// reused by #9 (SPICE) and #10 (graph); expose them from the single facade.
export { parseQuantity, formatQuantity, spiceValue } from "./units.js";
export { formatNumber, formatG, formatG6 } from "./format.js";

// SPICE netlist emitter (issue #9): byte-parity with the Python oracle's
// spice.py. `compileDesign` is the validation-gated public entry (refuses
// error-severity designs, matching the exporter); `compileSpice` is the raw
// emitter for an already-parsed IR.
export {
  compileSpice,
  compileDesign,
  BUILTIN_MODEL_CARDS,
} from "./emit/spice.js";
export type { SpiceArtifacts, CompileSpiceOptions } from "./emit/spice.js";

// Differential-fuzzer outcome reporting (for #43).
export { parseOutcome, parseOutcomeBytes, fnv1a64, type ParseOutcome } from "./outcome.js";

// Byte-level XML security entry points (UTF-8-only gate for untrusted bytes).
export { decodeXmlBytes, parseXmlBytes } from "./xml.js";

// Shared XML security contract limits (single source of truth with the oracle;
// docs/xml_security.md). Exported so callers and tests reference the same caps.
export {
  MAX_INPUT_BYTES,
  MAX_DEPTH,
  MAX_ATTR_COUNT,
  MAX_ATTR_VALUE_LEN,
  MAX_ELEMENT_COUNT,
} from "./xml.js";

// Error types (so callers can distinguish refusal kinds).
export { XmlParseError, XmlSecurityError } from "./xml.js";
export { AirParseError } from "./parser.js";

// AI-XML normalizer (issue #11): coerce near-miss AI XML into strict AIR shape.
// `normalize(xml)` returns the byte-exact canonical normalized document (the
// oracle's save_design path); `normalizeTree` is the raw tree transform (shared
// with the parser's model-build path). Kept SEPARATE from the patch stage.
export { normalize, normalizeTree } from "./normalize/index.js";

// Patch engine (issue #11): apply/preview XML patch documents against a design.
// `applyPatch(design, patch)` returns the canonical patched XML;
// `previewPatch(design, patch)` returns the structured diff + before/after
// validation deltas (mirrors patch_design / patch_preview). `applyPatchTree` /
// `patchOperations` are the raw-tree primitives; `PatchError` carries the
// oracle's verbatim ValueError messages.
export { applyPatch, previewPatch } from "./patch/facade.js";
export type { PatchPreview, DiagnosticSummary } from "./patch/facade.js";
export {
  applyPatchTree,
  patchOperations,
  PatchError,
} from "./patch/index.js";
export type { PatchOperation } from "./patch/index.js";
