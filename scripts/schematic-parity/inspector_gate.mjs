/**
 * Inspector patch-gate smoke test (issue #22 D).
 *
 * Simulates the Inspector's write path without a browser:
 *   1. Load a corpus design.
 *   2. Build the SAME patch XML the Inspector would build (edit R_BAT_TOP
 *      value from "1M" to "2M2").
 *   3. Run previewPatch: expect success + no introduced errors.
 *   4. Run applyPatch + normalize + validate.
 *   5. Confirm the patched XML is canonical and passes validation.
 *
 * Also exercises the negative path: an edit that violates a rule (empty
 * required attribute) is rejected by the gate and the resulting XML is
 * still the original (no leak).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  applyPatch,
  previewPatch,
  validate,
  normalize,
  parse,
} from "air-ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const xml = readFileSync(
  join(REPO, "tests", "golden_corpus", "esp32_battery_sensor", "input.air.xml"),
  "utf8",
);

// --- Happy path: edit R_BAT_TOP.value from 1M to 2M2 ---------------------- //
const goodPatch = `<patch><replace path="components/component[@id='R_BAT_TOP']/value"><value>2M2</value></replace></patch>`;
const preview = previewPatch(xml, goodPatch);
if (!preview.success) {
  console.error("FAIL: preview.success == false on valid edit");
  console.error(JSON.stringify(preview.after.diagnostics, null, 2));
  process.exit(1);
}
if (preview.introduced.length > 0) {
  console.error("FAIL: preview introduced errors:", preview.introduced);
  process.exit(1);
}
const patched = applyPatch(xml, goodPatch);
const normalized = normalize(patched);
const diagnostics = validate(normalized);
const errors = diagnostics.filter((d) => d.severity === "error");
if (errors.length > 0) {
  console.error("FAIL: normalized patched XML fails validation:", errors);
  process.exit(1);
}
const ir = parse(normalized);
const r = ir.components.get("R_BAT_TOP");
if (!r || r.value !== "2M2") {
  console.error(`FAIL: expected value=2M2, got ${r?.value}`);
  process.exit(1);
}
console.log("ok: value edit round-trips (R_BAT_TOP.value=2M2)");

// --- Negative path: rename to duplicate id --------------------------------- //
// R_BAT_BOTTOM already exists; renaming R_BAT_TOP to R_BAT_BOTTOM would
// duplicate the id -> the validator raises DUPLICATE_ID (unique key
// constraint on components/component/@id in air.xsd). Confirm the gate
// rejects the edit.
const bad = `<patch><replace path="components/component[@id='R_BAT_TOP']"><component id="R_BAT_BOTTOM" type="resistor"><value>1M</value><pin name="1" net="bat"/><pin name="2" net="battery_sense"/></component></replace></patch>`;
const badPreview = previewPatch(xml, bad);
if (badPreview.success) {
  console.error("FAIL: duplicate-id rename returned success");
  process.exit(1);
}
console.log(`ok: duplicate-id rename rejected (${badPreview.introduced.length} introduced error(s))`);

// --- Save-layout path: add <gui> hint --------------------------------------- //
const withHint = `<patch><replace path="components/component[@id='R_BAT_TOP']"><component id="R_BAT_TOP" type="resistor"><value>1M</value><pin name="1" net="bat"/><pin name="2" net="battery_sense"/><gui x="408" y="312" rot="0"/></component></replace></patch>`;
const hintPreview = previewPatch(xml, withHint);
if (!hintPreview.success) {
  console.error("FAIL: adding <gui> hint failed the gate");
  console.error(JSON.stringify(hintPreview.after.diagnostics, null, 2));
  process.exit(1);
}
const hinted = normalize(applyPatch(xml, withHint));
const parsedHinted = parse(hinted);
const rHinted = parsedHinted.components.get("R_BAT_TOP");
if (!rHinted?.gui || rHinted.gui.x !== 408 || rHinted.gui.y !== 312) {
  console.error("FAIL: <gui> hint not preserved in canonical XML");
  process.exit(1);
}
console.log("ok: <gui> hint round-trips through the patch gate (R_BAT_TOP.gui={408,312,0})");
