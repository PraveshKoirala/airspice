/**
 * Port of `packages/core/src/air/diagnostics.py`.
 *
 * A Diagnostic mirrors the frozen Python dataclass field-for-field; `toDict`
 * mirrors `Diagnostic.to_dict` (the exact key set the exporter serializes). The
 * DiagnosticBuilder assigns sequential ids `diag_00001`, `diag_00002`, ...
 * PER BUILDER INSTANCE -- exactly like the Python class's `self._next_id`.
 *
 * PARITY -- ID COUNTER SCOPE: the oracle calls `validate_tree(tree)` and
 * `validate_ir(ir)` with SEPARATE DiagnosticBuilder instances, then concatenates
 * the two lists (`validate_tree(tree) + validate_ir(ir)` in export_golden.py).
 * Each function's counter therefore restarts at diag_00001; if BOTH emit
 * diagnostics the ids collide (two diag_00001s). We reproduce that verbatim (one
 * builder per function, list concat) rather than "fixing" it -- the golden
 * corpus is the contract. In every committed design validate_tree emits nothing,
 * so the ids run 00001.. from validate_ir; the collision path is dormant but
 * preserved. // PARITY: see validate/index.ts validateAll.
 */

import type { JsonValue } from "../json.js";

export type Severity = "info" | "warning" | "error";

/** JSON-native values a diagnostic's observed/expected maps can hold. */
export type DiagValue = string | number | boolean | null | DiagValue[] | { [k: string]: DiagValue };

export interface Diagnostic {
  id: string;
  severity: Severity;
  domain: string;
  code: string;
  message: string;
  related_elements: string[];
  observed: Record<string, DiagValue>;
  expected: Record<string, DiagValue>;
  suggested_actions: string[];
}

/** Mirror of `Diagnostic.to_dict` -- the exact dict the exporter serializes. */
export function diagnosticToDict(d: Diagnostic): JsonValue {
  return {
    id: d.id,
    severity: d.severity,
    domain: d.domain,
    code: d.code,
    message: d.message,
    related_elements: d.related_elements,
    observed: d.observed as unknown as JsonValue,
    expected: d.expected as unknown as JsonValue,
    suggested_actions: d.suggested_actions,
  };
}

/** Optional fields for `make`, mirroring diagnostics.py's keyword args. */
export interface MakeOptions {
  relatedElements?: string[];
  observed?: Record<string, DiagValue>;
  expected?: Record<string, DiagValue>;
  suggestedActions?: string[];
}

/** Port of diagnostics.DiagnosticBuilder (per-instance sequential id counter). */
export class DiagnosticBuilder {
  private nextId = 1;

  make(
    severity: Severity,
    domain: string,
    code: string,
    message: string,
    options: MakeOptions = {},
  ): Diagnostic {
    // f"diag_{self._next_id:05d}" -- zero-padded to 5 digits.
    const id = `diag_${String(this.nextId).padStart(5, "0")}`;
    this.nextId += 1;
    return {
      id,
      severity,
      domain,
      code,
      message,
      related_elements: options.relatedElements ?? [],
      observed: options.observed ?? {},
      expected: options.expected ?? {},
      suggested_actions: options.suggestedActions ?? [],
    };
  }
}

/** Port of validation.has_errors. */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
