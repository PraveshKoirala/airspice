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

export { parseXml };
export { serializeModel };
export { canonicalizeTree };

// Re-export the typed model so consumers get the schema types from the facade.
export type * from "./model.js";

// Units + number formatting are part of the engine's public surface and are
// reused by #9 (SPICE) and #10 (graph); expose them from the single facade.
export { parseQuantity, formatQuantity, spiceValue } from "./units.js";
export { formatNumber, formatG, formatG6 } from "./format.js";

// Differential-fuzzer outcome reporting (for #43).
export { parseOutcome, fnv1a64, type ParseOutcome } from "./outcome.js";

// Error types (so callers can distinguish refusal kinds).
export { XmlParseError, XmlSecurityError } from "./xml.js";
export { AirParseError } from "./parser.js";
