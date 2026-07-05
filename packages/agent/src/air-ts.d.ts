/**
 * Ambient declaration for the `air-ts` engine, for the `agent` package's build.
 *
 * WHY: the tool runtime (issue #18) consumes air-ts, but the `agent` build
 * (`tsc -b`, which EMITS dist/) must not pull air-ts's SOURCE into its compiled
 * program -- air-ts is a separate composite project whose source lives outside
 * this package's rootDir, and packages/air-ts/node_modules is not installed in
 * the `agent` CI job. So at BUILD/typecheck time `air-ts` is an ambient module
 * declaring the small surface the tool runtime + tests use. At RUNTIME the real
 * air-ts source is resolved by the Vite alias (UI) and the Vitest alias (this
 * package's tests) -- exactly the source-aliased consumption packages/ui uses.
 * This ambient d.ts is the type half of that alias.
 *
 * Only prompts.ts imports air-ts VALUES in src/; every other src module consumes
 * air-ts through the injected EngineHooks seam. The test EngineHooks adapter
 * (tests/tools/engineAdapter.ts) wires the real air-ts functions declared here.
 * The declared shapes are a SUBSET of air-ts's real exports (open index
 * signatures where the runtime ignores extra fields), so no drift risk.
 */
declare module "air-ts" {
  /** A component spec entry (subset air-ts exports; open for unknown keys). */
  export interface ComponentSpec {
    required_pins?: string[];
    value_required?: boolean;
    required_properties?: string[];
    required_any?: string[];
    [key: string]: unknown;
  }

  /** A validation diagnostic (air-ts validate/diagnostics; open for extras). */
  export interface Diagnostic {
    id: string;
    severity: "error" | "warning" | "info";
    domain: string;
    code: string;
    message: string;
    related_elements: string[];
    [key: string]: unknown;
  }

  /** The structured op diff previewPatch returns (subset). */
  export interface PatchPreview {
    success: boolean;
    operations: unknown[];
    resolved: string[];
    introduced: string[];
    before: { errors: number; warnings: number; diagnostics: unknown[] };
    after: { errors: number; warnings: number; diagnostics: unknown[] };
  }

  /** Merged component-type registry (air-ts registry/index.ts). */
  export const COMPONENT_SPECS: Record<string, ComponentSpec>;
  /** Merged MCU registry keyed by part name (air-ts registry/index.ts). */
  export const MCUS: Record<string, unknown>;

  /** normalize(xml) -> canonical normalized XML; throws on malformed XML. */
  export function normalize(xml: string): string;
  /** validate(xml) -> ordered diagnostics (empty === clean). */
  export function validate(xml: string): Diagnostic[];
  /** applyPatch(design, patch) -> canonical patched XML. */
  export function applyPatch(designXml: string, patchXml: string): string;
  /** previewPatch(design, patch) -> structured diff + before/after deltas. */
  export function previewPatch(designXml: string, patchXml: string): PatchPreview;
}
