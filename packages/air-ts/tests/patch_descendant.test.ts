/**
 * Descendant-axis (`//`) support in the patch path resolver.
 *
 * CPython's ElementTree accepts `.//tag` (descendant search) in `find`, and the
 * oracle's patch engine resolves op targets with `root.find(path)` — so a patch
 * written with `.//component[@id='R1']/value` works against the Python oracle.
 * The TS port previously tokenized `//` as an empty step and silently treated
 * `.//x` as `./x`, so such patches failed with "Patch path not found". LLM
 * agents write `.//` habitually; these probes pin the ElementTree-compatible
 * behavior.
 */

import { describe, expect, it } from "vitest";
import { applyPatch, PatchError } from "../src/index.js";
import { parseXml } from "../src/index.js";
import { findFirst } from "../src/patch/path.js";

const DESIGN = `<system name="s" ir_version="0.1">
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vin" role="power" nominal_voltage="9V"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <value>10k</value>
      <pin name="1" net="vin"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <simulation_profiles/>
</system>`;

describe("descendant axis in patch paths", () => {
  it("finds a deep element via .//tag[@attr]", () => {
    const root = parseXml(DESIGN);
    const hit = findFirst(root, ".//component[@id='R1']");
    expect(hit).not.toBeNull();
    expect(hit!.attrib.get("id")).toBe("R1");
  });

  it("finds a deep child via .//tag/child", () => {
    const root = parseXml(DESIGN);
    const hit = findFirst(root, ".//component[@id='R1']/value");
    expect(hit).not.toBeNull();
    expect(hit!.tag).toBe("value");
  });

  it("supports tag//tag (descendant under a named child)", () => {
    const root = parseXml(DESIGN);
    const hit = findFirst(root, "components//pin[@name='2']");
    expect(hit).not.toBeNull();
    expect(hit!.attrib.get("net")).toBe("gnd");
  });

  it("still resolves plain child paths exactly as before", () => {
    const root = parseXml(DESIGN);
    const hit = findFirst(root, "./components/component[@id='R1']/value");
    expect(hit).not.toBeNull();
    expect(hit!.tag).toBe("value");
  });

  it("applies a replace op addressed with .//", () => {
    const patch = `<patch>
      <reason>retune</reason>
      <replace path=".//component[@id='R1']/value"><value>12k</value></replace>
    </patch>`;
    const out = applyPatch(DESIGN, patch);
    expect(out).toContain("<value>12k</value>");
    expect(out).not.toContain("<value>10k</value>");
  });

  it("applies an add op addressed with .//", () => {
    const patch = `<patch>
      <add path=".//components"><component id="C1" type="capacitor"><value>100nF</value><pin name="1" net="vin"/><pin name="2" net="gnd"/></component></add>
    </patch>`;
    const out = applyPatch(DESIGN, patch);
    expect(out).toContain('id="C1"');
  });

  it("a non-matching descendant path still raises not-found", () => {
    const patch = `<patch>
      <replace path=".//component[@id='NOPE']"><component id="X" type="resistor"/></replace>
    </patch>`;
    expect(() => applyPatch(DESIGN, patch)).toThrow(PatchError);
  });
});
