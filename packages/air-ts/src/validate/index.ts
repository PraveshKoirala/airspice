/**
 * Validation facade (issue #8): the public entry points that reproduce the
 * oracle's `validate_tree(tree) + validate_ir(ir)` sequence and serialize the
 * result to the byte-exact `diagnostics.json` the golden corpus commits.
 *
 * Emission order & id counters are PARITY-critical -- see diagnostics.ts. The
 * exporter (scripts/export_golden.py) builds diagnostics as:
 *     diagnostics = validate_tree(tree) + validate_ir(ir)
 *     payload = {"success": not has_errors(diagnostics),
 *                "diagnostics": [d.to_dict() for d in diagnostics]}
 *     dumps(payload)  # json.dumps(indent=2, sort_keys=True) + "\n"
 * `validateAll` and `serializeDiagnostics` mirror this exactly.
 */

import type { SystemIR } from "../model.js";
import { type XmlElement, find, findAll } from "../xml.js";
import { dumps, type JsonValue } from "../json.js";
import { type Diagnostic, diagnosticToDict, hasErrors } from "./diagnostics.js";
import { validateIr, validateTree, type TreeSchemaView } from "./rules.js";

export { validateTree, validateIr } from "./rules.js";
export { hasErrors } from "./diagnostics.js";
export type { Diagnostic, Severity } from "./diagnostics.js";
export type { TreeSchemaView } from "./rules.js";

/**
 * Build the schema view `validate_tree` inspects, from the RAW parsed element
 * tree (the same tree the canonicalizer consumes). Mirrors the ElementTree
 * accesses in validation.validate_tree:
 *   - root.tag / root.attrib
 *   - root.find(section)          (top-level section presence)
 *   - root.findall("./nets/net")  (and component/test/profile) for DUPLICATE_ID
 */
export function buildTreeSchemaView(root: XmlElement): TreeSchemaView {
  const presentSections = new Set<string>();
  for (const section of ["metadata", "nets", "components", "tests", "simulation_profiles"]) {
    if (find(root, section) !== null) presentSections.add(section);
  }

  // ./<parent>/<child> path queries: children of the (first) parent section.
  const countIds = (parentTag: string, childTag: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    const parent = find(root, parentTag);
    if (parent === null) return counts;
    for (const element of findAll(parent, childTag)) {
      const id = element.attrib.get("id");
      if (id) counts[id] = (counts[id] ?? 0) + 1;
    }
    return counts;
  };

  const rootAttribs: Record<string, string> = {};
  for (const [k, v] of root.attrib) rootAttribs[k] = v;

  return {
    rootTag: root.tag,
    rootAttribs,
    presentSections,
    idCounts: {
      net: countIds("nets", "net"),
      component: countIds("components", "component"),
      test: countIds("tests", "test"),
      profile: countIds("simulation_profiles", "profile"),
    },
  };
}

/**
 * Full validation over a raw tree + its parsed model, in the exporter's order.
 * PARITY: `validate_tree` and `validate_ir` use SEPARATE id counters; we
 * concatenate their outputs without renumbering (diagnostics.ts).
 */
export function validateAll(root: XmlElement, ir: SystemIR): Diagnostic[] {
  const view = buildTreeSchemaView(root);
  return [...validateTree(view), ...validateIr(ir)];
}

/** The `diagnostics.json` payload object (before serialization). */
export interface DiagnosticsPayload {
  success: boolean;
  diagnostics: Diagnostic[];
}

/** Build the payload the exporter writes: {success, diagnostics}. */
export function buildDiagnosticsPayload(diagnostics: Diagnostic[]): DiagnosticsPayload {
  return { success: !hasErrors(diagnostics), diagnostics };
}

/**
 * Serialize a diagnostics list to the byte-exact `diagnostics.json` string
 * (trailing newline included), matching the oracle's
 * `json.dumps({success, diagnostics:[d.to_dict()...]}, indent=2, sort_keys=True) + "\n"`.
 */
export function serializeDiagnostics(diagnostics: Diagnostic[]): string {
  const payload: JsonValue = {
    success: !hasErrors(diagnostics),
    diagnostics: diagnostics.map(diagnosticToDict),
  };
  return dumps(payload);
}
