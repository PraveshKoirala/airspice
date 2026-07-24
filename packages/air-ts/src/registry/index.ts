/**
 * Registry facade (port of `registry.py` + the SPICE builtins from `spice.py`).
 *
 * Assembles the same COMPONENT_SPECS / MCUS the oracle exposes, by merging the
 * hand-ported built-in fallbacks (builtins.ts) with the compiled-in on-disk
 * registry (data.generated.ts). The merge order reproduces Python exactly:
 *   MCUS           = { ...BUILTIN_MCUS,       ...GENERATED_MCUS }
 *   COMPONENT_SPECS= { ...BUILTIN_COMPONENTS, ...GENERATED_COMPONENT_SPECS }
 * i.e. `dict(_BUILTIN_...)` then per-key file override -- the file wins on a key
 * collision, the builtin answers when a file is absent. No fs / network I/O.
 */

import type { ComponentSpec, McuSpec, SpiceModelEntry } from "./types.js";
import { BUILTIN_COMPONENTS, BUILTIN_MCUS, PASSIVE_TYPES, SUPPORTED_SPICE_TYPES } from "./builtins.js";
import { GENERATED_COMPONENT_SPECS, GENERATED_MCUS, GENERATED_SPICE_MODELS } from "./data.generated.js";

/** Merged MCU registry (built-ins overridden by on-disk registry files). */
export const MCUS: Record<string, McuSpec> = { ...BUILTIN_MCUS, ...GENERATED_MCUS };

/** Merged component spec registry (built-ins overridden by registry files). */
export const COMPONENT_SPECS: Record<string, ComponentSpec> = {
  ...BUILTIN_COMPONENTS,
  ...GENERATED_COMPONENT_SPECS,
};

/**
 * Part-level SPICE model library (issue #60): real ``.model`` cards imported
 * into registry/imported/*.json, keyed by UPPERCASE model name. Mirror of
 * registry.py `SPICE_MODELS`. Consulted by the SPICE emitter (to EMIT the card)
 * and the validator (to BACK the part). There are no built-in fallbacks -- the
 * whole library is the compiled-in generated data.
 */
export const SPICE_MODELS: Record<string, SpiceModelEntry> = GENERATED_SPICE_MODELS;

export { PASSIVE_TYPES, SUPPORTED_SPICE_TYPES };
export type { ComponentSpec, McuSpec, PeripheralSpec, SpiceModelEntry } from "./types.js";

/**
 * SPICE builtins ported from `spice.py` (BUILTIN_SPICE_MODELS / _SUBCKTS). Kept
 * with the registry so the validator's _validate_spice_models has a single import
 * for the "what the compiler can back" sets. Values are compared case-insensitively
 * at the call site (the oracle uppercases before membership tests).
 */
export const BUILTIN_SPICE_MODELS: ReadonlySet<string> = new Set(["NMOS", "PMOS", "NPN", "PNP", "D"]);

/** No .subckt definitions are ever emitted (spice.py: empty frozenset). */
export const BUILTIN_SPICE_SUBCKTS: ReadonlySet<string> = new Set<string>();
