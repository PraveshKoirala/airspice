/**
 * Shared `<patch>` builders and the gate runner for schematic edits.
 *
 * Extracted from Inspector.tsx (issue #22 D) so the drag/nudge write path
 * (issue #23) can go through EXACTLY the same normalize -> validate ->
 * applyPatch pipeline. This is the ONE WRITE PATH invariant enforced from
 * AGENTS.md guardrail #6: nothing may mutate the design XML except through
 * the gate.
 *
 * Public surface:
 *   - `runGate(currentXml, patchXml)` runs a proposed patch through
 *     previewPatch + applyPatch + normalize + validate. Returns
 *     `{ ok: true, xml }` on success or `{ ok: false, message }` when any
 *     step fails or introduces an error-severity diagnostic. The design
 *     store is UNCHANGED by this call.
 *   - `saveHintOp(comp, hint)` returns a single `<replace ...>` op string
 *     for one component's <gui> hint. Multiple ops can be concatenated
 *     into one `<patch>` document -- the multi-drag write path emits ONE
 *     patch for the whole group so undo restores the group in one step.
 *   - `saveHintPatch(comp, hint)` wraps saveHintOp in `<patch>...</patch>`
 *     for the single-component case (kept for Inspector's original API).
 *   - `renameComponentPatch(comp, newId)` / `replaceValuePatch(id, value)`
 *     are the other two builders used by the Inspector; parked here so
 *     Inspector can import from a single module.
 */

import {
  applyPatch as airApplyPatch,
  previewPatch as airPreviewPatch,
  validate as airValidate,
  normalize as airNormalize,
} from "air-ts";
import type { GuiHint } from "./types";

export type GateOutcome =
  | { ok: true; xml: string }
  | { ok: false; message: string };

/**
 * Run a proposed patch through the same gate the agent tool runtime uses.
 * The design store is not touched here; the caller decides whether to
 * `setUserXml(outcome.xml)` on success.
 */
export function runGate(currentXml: string, patchXml: string): GateOutcome {
  try {
    // 1) previewPatch surfaces validity BEFORE we mutate anything. If the
    //    patched design carries any error-severity diagnostic OR
    //    previewPatch itself throws (unresolvable path, malformed op), we
    //    reject the edit and leave the store untouched.
    const preview = airPreviewPatch(currentXml, patchXml);
    if (!preview.success) {
      const first = preview.after.diagnostics[0];
      const msg =
        first !== undefined
          ? String(
              (first as { code?: string; message?: string }).code ?? "invalid",
            ) +
            ": " +
            String((first as { message?: string }).message ?? "edit rejected")
          : "edit rejected (introduced " +
            preview.introduced.length +
            " error(s))";
      return { ok: false, message: msg };
    }
    // 2) applyPatch produces the canonical patched XML. Then we normalize
    //    + validate ONCE MORE on the applied bytes -- belt-and-braces: the
    //    same shape agent gateDesign uses (normalize -> validate).
    const patched = airApplyPatch(currentXml, patchXml);
    const normalized = airNormalize(patched);
    const diagnostics = airValidate(normalized);
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      return {
        ok: false,
        message: errors[0]!.code + ": " + errors[0]!.message,
      };
    }
    return { ok: true, xml: normalized };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * XML-escape a text run for embedding inside a `<value>` payload.
 * Values are validated by the schema so unusual characters are rare, but
 * we escape defensively -- an `&` in a resistor value string ("50R&") would
 * otherwise produce malformed patch XML.
 */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ParsedComponent {
  id: string;
  type: string;
  part: string | null;
  spice_model: string | null;
  spice_subckt: string | null;
  value: string | null;
  pins: Map<string, { name: string; net: string; function: string | null }>;
  properties: Map<string, string>;
  gui: { x: number; y: number; rot: number } | null;
}

/**
 * Build the child list of a `<component>` element as canonical XML, so a
 * `<replace path=".../component[@id='...']">` payload preserves every
 * existing pin/property/value/gui.
 */
export function serializeComponentBody(comp: ParsedComponent): { attrs: string; body: string } {
  const attrs: string[] = [`id="${xmlEscape(comp.id)}"`, `type="${xmlEscape(comp.type)}"`];
  if (comp.part) attrs.push(`part="${xmlEscape(comp.part)}"`);
  if (comp.spice_model) attrs.push(`spice_model="${xmlEscape(comp.spice_model)}"`);
  if (comp.spice_subckt) attrs.push(`spice_subckt="${xmlEscape(comp.spice_subckt)}"`);
  const parts: string[] = [];
  if (comp.value !== null) parts.push(`<value>${xmlEscape(comp.value)}</value>`);
  for (const pin of comp.pins.values()) {
    const bits: string[] = [`name="${xmlEscape(pin.name)}"`, `net="${xmlEscape(pin.net)}"`];
    if (pin.function) bits.push(`function="${xmlEscape(pin.function)}"`);
    parts.push(`<pin ${bits.join(" ")}/>`);
  }
  if (comp.gui) {
    parts.push(
      `<gui x="${comp.gui.x}" y="${comp.gui.y}" rot="${comp.gui.rot}"/>`,
    );
  }
  for (const [name, value] of comp.properties) {
    parts.push(`<property name="${xmlEscape(name)}" value="${xmlEscape(value)}"/>`);
  }
  return { attrs: attrs.join(" "), body: parts.join("") };
}

export function replaceValuePatch(componentId: string, newValue: string): string {
  const path = `components/component[@id='${componentId}']/value`;
  return `<patch><replace path="${path}"><value>${xmlEscape(newValue)}</value></replace></patch>`;
}

export function renameComponentPatch(comp: ParsedComponent, newId: string): string {
  const { attrs, body } = serializeComponentBody({ ...comp, id: newId });
  const path = `components/component[@id='${comp.id}']`;
  return `<patch><replace path="${path}"><component ${attrs}>${body}</component></replace></patch>`;
}

/**
 * A single `<replace>` op that upserts a `<gui>` hint on `comp`. Multiple
 * ops can be concatenated into one `<patch>` for group drag (issue #23):
 * a single patch = a single design-store update = a single undo step for
 * the whole group.
 */
export function saveHintOp(comp: ParsedComponent, hint: GuiHint): string {
  const withHint: ParsedComponent = {
    ...comp,
    gui: { x: hint.x, y: hint.y, rot: hint.rot },
  };
  const { attrs, body } = serializeComponentBody(withHint);
  const path = `components/component[@id='${comp.id}']`;
  return `<replace path="${path}"><component ${attrs}>${body}</component></replace>`;
}

export function saveHintPatch(comp: ParsedComponent, hint: GuiHint): string {
  return `<patch>${saveHintOp(comp, hint)}</patch>`;
}

/**
 * Build a single `<patch>` document containing one `<gui>` upsert per
 * (component, hint) pair. Returns `null` when the input list is empty --
 * callers should skip the commit in that case.
 */
export function saveHintsPatch(
  entries: Array<{ comp: ParsedComponent; hint: GuiHint }>,
): string | null {
  if (entries.length === 0) return null;
  const ops = entries.map((e) => saveHintOp(e.comp, e.hint)).join("");
  return `<patch>${ops}</patch>`;
}
