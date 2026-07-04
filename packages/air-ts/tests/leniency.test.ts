/**
 * Parser-leniency parity tests for behaviors the golden corpus does NOT exercise
 * but the issue explicitly requires porting (issue #7 deliverable 4):
 *   - pin aliases net= / node= / ref=
 *   - net-owned <node> materializing component-owned <pin>s
 *   - the <pins> wrapper being flattened
 *   - part-as-type coercion + name->id coercion
 *   - bjt spice_model inference + bjt/mosfet pin-name uppercasing
 *   - value-from-parameters with default-unit application
 *   - <simulation_profile> -> <profile> + solver-> backend normalization
 *   - implied net-role inference for bare nets
 *
 * PROVENANCE: each case's expected `model` (byte-exact model.json) and
 * `canonical` (byte-exact canonical.air.xml) were produced by running the Python
 * oracle (air.parser + air.model_dump + air.canonicalizer) on the exact `xml`
 * string in the fixture. tests/fixtures/leniency.json is that oracle output. The
 * raw-vs-normalized split is a load-bearing case: e.g. `node=`/`ref=` are
 * resolved to `net` in the model but PRESERVED in canonical (canonicalization
 * runs on the un-normalized tree), and these fixtures pin exactly that.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, canonicalize, serializeModel } from "../src/index.js";
import { byteDiff } from "./harness.js";

interface LeniencyCase {
  name: string;
  xml: string;
  model: string;
  canonical: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const cases: LeniencyCase[] = JSON.parse(
  readFileSync(join(HERE, "fixtures", "leniency.json"), "utf-8"),
) as LeniencyCase[];

it("loaded the leniency fixtures", () => {
  expect(cases.length).toBeGreaterThanOrEqual(8);
});

describe("parser leniencies: model.json parity", () => {
  for (const c of cases) {
    it(`${c.name} model`, () => {
      const actual = serializeModel(parse(c.xml));
      const diff = byteDiff(actual, c.model, `${c.name}/model`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});

describe("parser leniencies: canonical.air.xml parity", () => {
  for (const c of cases) {
    it(`${c.name} canonical`, () => {
      const actual = canonicalize(c.xml);
      const diff = byteDiff(actual, c.canonical, `${c.name}/canonical`);
      expect(diff.equal, diff.message).toBe(true);
    });
  }
});
