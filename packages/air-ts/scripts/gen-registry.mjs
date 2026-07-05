/**
 * Build-time registry codegen (issue #8, deliverable 3).
 *
 * The oracle's `registry.py` loads `registry/mcu/*.json` and
 * `registry/components/*.json` from disk at import time and MERGES them over a
 * set of Python built-in fallbacks (dict(_BUILTIN_...) then file overrides by
 * key). air-ts must NOT do filesystem or network I/O (epic #6: browser / Web
 * Worker safe), so we compile the on-disk registry INTO the package here: this
 * script reads the same JSON files and emits `src/registry/data.generated.ts`,
 * a pure data module with zero runtime dependency on `fs`.
 *
 * The Python built-in fallback semantics are preserved at RUNTIME, not baked in
 * here: `builtins.ts` holds the hand-ported _BUILTIN_MCUS / _BUILTIN_COMPONENTS,
 * and `registry.ts` merges `{...builtins, ...generated}` exactly like Python's
 * `dict(_BUILTIN_...)` + per-key file override. So if a registry file is ever
 * removed, the builtin still answers (same as Python when the dir is absent),
 * and when both exist the file wins (same as Python). This script only captures
 * the *file* half; the fallback half lives in source and is not generated.
 *
 * Determinism: JSON object key order is preserved from the source files, arrays
 * verbatim, and the file list is sorted so regeneration is byte-stable. Run via
 * `npm run gen:registry` (wired into build/typecheck/test as a pre-step); the
 * generated file is committed so CI needs no separate generate step, and a drift
 * check (`--check`) fails if the committed output is stale.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/air-ts/scripts -> repo root is three levels up.
const REPO_ROOT = join(HERE, "..", "..", "..");
const REGISTRY_DIR = join(REPO_ROOT, "registry");
const OUT_PATH = join(HERE, "..", "src", "registry", "data.generated.ts");

/** Read every *.json in a registry subdir, sorted by filename (stable order). */
function readRegistryDir(sub) {
  const dir = join(REGISTRY_DIR, sub);
  let entries;
  try {
    entries = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    entries = [];
  }
  return entries.map((name) => ({
    name,
    data: JSON.parse(readFileSync(join(dir, name), "utf-8")),
  }));
}

/**
 * Component specs: `registry.py` keys each entry by its `type` and drops the
 * `type` field from the stored value (`{k: v for k, v in data.items() if k != "type"}`).
 * We reproduce that transform so the generated map matches COMPONENT_SPECS exactly.
 */
function buildComponentSpecs() {
  const files = readRegistryDir("components");
  const specs = {};
  for (const { data } of files) {
    const type = data.type;
    const entry = {};
    for (const [k, v] of Object.entries(data)) {
      if (k !== "type") entry[k] = v;
    }
    specs[type] = entry;
  }
  return specs;
}

/**
 * MCU registry: `registry.py` keys each by `part`, drops `pins` from the shallow
 * copy, then re-adds `pins` as {pin: set(functions)}. We keep `pins` as arrays in
 * the generated data (JSON-native, and `sorted(set)` parity is applied at the
 * emit site in the validator, not here), preserving all other fields verbatim.
 */
function buildMcus() {
  const files = readRegistryDir("mcu");
  const mcus = {};
  for (const { name, data } of files) {
    // ORDER GUARD (issue #8 rework round 1): `power_pins` is the ONE registry
    // map the validator ITERATES (MISSING_MCU_POWER_PIN emission order). It is
    // stored as a plain object, which is only order-safe while no key is a pure
    // integer ("1", "42"): both JSON.parse here and the emitted TS literal
    // would reorder integer-like keys numerically, diverging from Python's
    // file-order dict. Rail names are never bare integers today; if one ever
    // appears, fail the generation loudly instead of silently reordering.
    for (const key of Object.keys(data.power_pins ?? {})) {
      if (/^\d+$/.test(key)) {
        console.error(
          `gen-registry: ${name}: power_pins key '${key}' is a pure integer. ` +
            "Plain-object storage would reorder it (JS integer-like key rule); " +
            "convert the generated power_pins to an ordered structure before " +
            "admitting integer rail names.",
        );
        process.exit(1);
      }
    }
    mcus[data.part] = data;
  }
  return mcus;
}

function render() {
  const componentSpecs = buildComponentSpecs();
  const mcus = buildMcus();
  const banner = [
    "/**",
    " * GENERATED FILE - do not edit by hand.",
    " *",
    " * Produced by `npm run gen:registry` (scripts/gen-registry.mjs) from the",
    " * on-disk registry under repo-root `registry/`. It compiles the registry",
    " * INTO the package so air-ts does no fs / network I/O at runtime (epic #6).",
    " * Regenerate after changing any registry/*.json; the committed copy is drift-",
    " * checked in CI (`npm run gen:registry -- --check`).",
    " *",
    " * The built-in fallbacks (Python's _BUILTIN_MCUS / _BUILTIN_COMPONENTS) live",
    " * in ./builtins.ts and are merged over this data in ./registry.ts, mirroring",
    " * registry.py's dict(_BUILTIN_...) + per-key file override.",
    " */",
    "",
    'import type { ComponentSpec, McuSpec } from "./types.js";',
    "",
  ].join("\n");

  const specsJson = JSON.stringify(componentSpecs, null, 2);
  const mcusJson = JSON.stringify(mcus, null, 2);

  return (
    banner +
    "/** Component specs loaded from registry/components/*.json (keyed by type). */\n" +
    "export const GENERATED_COMPONENT_SPECS: Record<string, ComponentSpec> =\n" +
    specsJson +
    ";\n\n" +
    "/** MCU specs loaded from registry/mcu/*.json (keyed by part). */\n" +
    "export const GENERATED_MCUS: Record<string, McuSpec> =\n" +
    mcusJson +
    ";\n"
  );
}

function main() {
  const check = process.argv.includes("--check");
  const content = render();
  if (check) {
    let existing = "";
    try {
      existing = readFileSync(OUT_PATH, "utf-8");
    } catch {
      existing = "";
    }
    if (existing !== content) {
      console.error(
        "gen-registry --check: src/registry/data.generated.ts is STALE. " +
          "Run `npm run gen:registry` and commit the result.",
      );
      process.exit(1);
    }
    console.log("gen-registry --check: generated registry is up to date.");
    return;
  }
  writeFileSync(OUT_PATH, content, { encoding: "utf-8" });
  console.log(`gen-registry: wrote ${OUT_PATH}`);
}

main();
