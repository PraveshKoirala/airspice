/**
 * String-level patch facade (issue #11 deliverable 7): applyPatch / previewPatch
 * over XML strings, mirroring the oracle's service layer (service.py) but PURE
 * (no filesystem -- browser/Worker-safe, epic #6).
 *
 *   applyPatch(designXml, patchXml)   -> byte-exact canonical patched XML,
 *       mirroring patch_design's apply -> canonicalize_tree (service.py:88-94).
 *       (patch_design gates the WRITE on validity; that gating is a service
 *       concern -- the pure engine returns the canonical patched document and
 *       lets the caller decide. previewPatch reports validity for that decision.)
 *   previewPatch(designXml, patchXml) -> the structured preview object
 *       patch_preview returns (service.py:98-111): operations, before/after
 *       diagnostic summaries, and the resolved/introduced code deltas.
 *
 * PARITY: the diagnostic summary/delta helpers reproduce service.py's
 * `_diagnostic_summary` / `_diagnostic_delta` / `_diagnostic_key` verbatim
 * (service.py:194-208), keyed on severity:domain:code:related_elements so the
 * resolved/introduced sets match the oracle's.
 */

import { parseXml } from "../xml.js";
import { parseTree } from "../parser.js";
import { canonicalizeTree } from "../canonicalizer.js";
import { validateAll } from "../validate/index.js";
import { hasErrors, type Diagnostic } from "../validate/diagnostics.js";
import { diagnosticToDict } from "../validate/diagnostics.js";
import type { JsonValue } from "../json.js";
import { applyPatchTree, patchOperations, type PatchOperation } from "./index.js";

/** The `before`/`after` shape of patch_preview (service.py:_diagnostic_summary). */
export interface DiagnosticSummary {
  errors: number;
  warnings: number;
  diagnostics: JsonValue[];
}

/** The object patch_preview returns (service.py:104-111). */
export interface PatchPreview {
  success: boolean;
  operations: PatchOperation[];
  before: DiagnosticSummary;
  after: DiagnosticSummary;
  resolved: string[];
  introduced: string[];
}

/**
 * Apply a patch to a design and return the canonical patched XML. Mirrors
 * patch_design's `apply_patch_tree(...)` -> `canonicalize_tree(updated)`.
 */
export function applyPatch(designXml: string, patchXml: string): string {
  const designRoot = parseXml(designXml);
  const patchRoot = parseXml(patchXml);
  const updated = applyPatchTree(designRoot, patchRoot);
  return canonicalizeTree(updated);
}

/**
 * Preview a patch: the structured op diff plus the before/after validation
 * summaries and the resolved/introduced diagnostic-code deltas. Mirrors
 * patch_preview (service.py:98-111).
 */
export function previewPatch(designXml: string, patchXml: string): PatchPreview {
  const designRoot = parseXml(designXml);
  const patchRoot = parseXml(patchXml);

  // before = validate_tree(design_tree) + validate_ir(parse_tree(design_tree))
  const before = validateDocument(designRoot);
  const updated = applyPatchTree(designRoot, patchRoot);
  const after = validateDocument(updated);

  return {
    success: !hasErrors(after),
    operations: patchOperations(patchRoot),
    before: diagnosticSummary(before),
    after: diagnosticSummary(after),
    resolved: diagnosticDelta(before, after),
    introduced: diagnosticDelta(after, before),
  };
}

/**
 * validate_tree(tree) + validate_ir(parse_tree(tree)) on one raw root, exactly
 * as service.py builds `before`/`after` (validateAll runs both with the oracle's
 * separate-builder id semantics -- see validate/index.ts).
 */
function validateDocument(root: import("../xml.js").XmlElement): Diagnostic[] {
  const ir = parseTree(root);
  return validateAll(root, ir);
}

/** service.py:_diagnostic_summary. */
function diagnosticSummary(diagnostics: Diagnostic[]): DiagnosticSummary {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
  }
  return {
    errors,
    warnings,
    diagnostics: diagnostics.map((d) => diagnosticToDict(d)),
  };
}

/**
 * service.py:_diagnostic_delta -- the keys in `left` not present in `right`.
 * Order follows `left` (list comprehension order), matching the oracle.
 */
function diagnosticDelta(left: Diagnostic[], right: Diagnostic[]): string[] {
  const rightKeys = new Set(right.map(diagnosticKey));
  const out: string[] = [];
  for (const d of left) {
    const key = diagnosticKey(d);
    if (!rightKeys.has(key)) out.push(key);
  }
  return out;
}

/** service.py:_diagnostic_key. */
function diagnosticKey(d: Diagnostic): string {
  return `${d.severity}:${d.domain}:${d.code}:${d.related_elements.join(",")}`;
}
