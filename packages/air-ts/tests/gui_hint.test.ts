/**
 * <gui> hint schema round-trip (issue #22 B).
 *
 * Verifies that:
 *   1. A component's optional `<gui x=".." y=".." rot=".."/>` child is parsed
 *      into `Component.gui` (float x/y, integer rot) or `null` if absent.
 *   2. `serializeModel` OMITS the `gui` key when it is null, so pre-#22 corpus
 *      designs still produce byte-identical model.json (the omit-when-null
 *      contract mirrored from the Python `model_dump.model_to_dict`).
 *   3. `canonicalizeTree` moves the `<gui>` child to sit AFTER the last
 *      `<pin>` element within its `<component>`, regardless of where the
 *      author placed it. This ordering is documented on the XSD `<gui>`
 *      element (schemas/air.xsd) and encoded in both engines.
 *   4. Round-trip: parse(x) -> serialize -> parse(x) preserves the gui hint.
 */

import { describe, expect, it } from "vitest";
import { parse, canonicalize, serializeModel } from "../src/index.js";

const DESIGN_WITH_GUI = `<?xml version="1.0" encoding="UTF-8"?>
<system name="hint_demo" ir_version="0.1">
  <metadata><title>t</title></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vcc" role="power"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <value>10k</value>
      <pin name="1" net="vcc"/>
      <pin name="2" net="gnd"/>
      <gui x="120" y="240" rot="0"/>
    </component>
    <component id="R2" type="resistor">
      <gui x="480" y="240"/>
      <value>4k7</value>
      <pin name="1" net="vcc"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <tests>
    <test id="t1">
      <setup><set_voltage net="vcc" value="5V"/></setup>
      <run duration="1ms"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="only" default="true"><run test="t1"/></profile>
  </simulation_profiles>
</system>`;

const DESIGN_WITHOUT_GUI = `<?xml version="1.0" encoding="UTF-8"?>
<system name="no_hint" ir_version="0.1">
  <metadata><title>t</title></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vcc" role="power"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <value>10k</value>
      <pin name="1" net="vcc"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <tests>
    <test id="t1">
      <setup><set_voltage net="vcc" value="5V"/></setup>
      <run duration="1ms"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="only" default="true"><run test="t1"/></profile>
  </simulation_profiles>
</system>`;

describe("<gui> hint parsing", () => {
  it("reads x/y as floats and rot as integer (default 0)", () => {
    const ir = parse(DESIGN_WITH_GUI);
    const r1 = ir.components.get("R1")!;
    const r2 = ir.components.get("R2")!;
    expect(r1.gui).toEqual({ x: 120, y: 240, rot: 0 });
    // R2 omits rot -> defaults to 0.
    expect(r2.gui).toEqual({ x: 480, y: 240, rot: 0 });
  });

  it("returns null when the <gui> child is absent", () => {
    const ir = parse(DESIGN_WITHOUT_GUI);
    expect(ir.components.get("R1")!.gui).toBeNull();
  });

  it("model.json includes gui only when the hint is present", () => {
    const withGui = serializeModel(parse(DESIGN_WITH_GUI));
    const withoutGui = serializeModel(parse(DESIGN_WITHOUT_GUI));
    // The design WITHOUT any gui hints must not emit a "gui" key at all.
    expect(withoutGui).not.toContain('"gui"');
    // The design WITH gui hints emits the key on those components.
    expect(withGui).toContain('"gui"');
    // JSON is sort-keyed, so rot < x < y within each hint object.
    expect(withGui).toContain('"gui": {\n        "rot": 0,\n        "x": 120,\n        "y": 240\n      }');
  });
});

describe("<gui> canonical ordering", () => {
  it("moves <gui> to sit immediately after the last <pin>", () => {
    const canon = canonicalize(DESIGN_WITH_GUI);
    // Extract the R2 block; the author put <gui> FIRST -- the canonicalizer
    // must move it to after the last <pin>.
    const r2Block = extractComponent(canon, "R2");
    const order = ["<value>", "<pin ", "<pin ", "<gui "];
    let cursor = 0;
    for (const token of order) {
      const idx = r2Block.indexOf(token, cursor);
      expect(idx, `expected ${token} at or after position ${cursor} in\n${r2Block}`).toBeGreaterThan(-1);
      cursor = idx + token.length;
    }
    // Sanity: R1 (author already put <gui> last) is unchanged in ordering.
    const r1Block = extractComponent(canon, "R1");
    expect(r1Block.indexOf("<gui ")).toBeGreaterThan(r1Block.lastIndexOf("<pin "));
  });

  it("gui hint round-trips: parse -> canonicalize -> parse preserves the hint", () => {
    const ir1 = parse(DESIGN_WITH_GUI);
    const canon = canonicalize(DESIGN_WITH_GUI);
    const ir2 = parse(canon);
    expect(ir2.components.get("R1")!.gui).toEqual(ir1.components.get("R1")!.gui);
    expect(ir2.components.get("R2")!.gui).toEqual(ir1.components.get("R2")!.gui);
  });

  it("attributes on <gui> are sorted (rot, x, y)", () => {
    const canon = canonicalize(DESIGN_WITH_GUI);
    // R1's <gui rot="0" x="120" y="240"/> after canonicalization.
    expect(canon).toContain('<gui rot="0" x="120" y="240"/>');
  });
});

function extractComponent(xml: string, id: string): string {
  const start = xml.indexOf(`<component id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const end = xml.indexOf("</component>", start);
  expect(end).toBeGreaterThan(start);
  return xml.slice(start, end + "</component>".length);
}
