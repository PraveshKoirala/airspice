import { describe, it, expect } from "vitest";
import {
  parse,
  validate,
  hasErrors,
  compileDesign,
  emitKicadSchematic,
  exportKicad,
  importSpiceNetlist,
  parseSpiceNetlistToAirXml,
} from "../src/index.js";

/** Assert every parenthesis in an S-expression is balanced (outside strings). */
function parensBalanced(sexpr: string): boolean {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (const ch of sexpr) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === "(") depth++;
    else if (!inStr && ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !inStr;
}

describe("Milestone M7: SPICE import → valid, simulatable AIR", () => {
  it("imports a passive divider that validates clean and simulates", () => {
    const deck = `Voltage Divider Deck
R1 vcc mid 1k
R2 mid 0 2k
V1 vcc 0 DC 5
.end`;
    const { airXml, components, dropped } = importSpiceNetlist(deck);
    expect(dropped).toHaveLength(0);
    expect(components.map((c) => c.id).sort()).toEqual(["R1", "R2", "V1"]);

    const ir = parse(airXml);
    expect(ir.components.size).toBe(3);
    // ground net present (node 0 -> ground role) so MISSING_GROUND cannot fire.
    expect([...ir.nets.values()].some((n) => n.role === "ground")).toBe(true);

    // The whole point: no ERROR-severity diagnostics -> a real, valid design.
    const diags = validate(airXml);
    expect(hasErrors(diags)).toBe(false);

    // compileDesign is validation-gated; it returns null on an error design.
    const artifacts = compileDesign(airXml);
    expect(artifacts).not.toBeNull();
    expect(artifacts!.netlist).toContain("R1");
    expect(artifacts!.netlist).toContain("R2");
  });

  it("imports active devices (diode, BJT, MOSFET) with builtin models, no errors", () => {
    const deck = `Active Devices
* NPN switch driven from a divider, PMOS high-side, protection diode
V1 vcc 0 DC 12
R1 vcc base 4700
R2 base 0 1k
Q1 coll base 0 QN2222
M1 vcc gate coll 0 BSS84P
D1 coll vcc DPROT
.model QN2222 NPN (BF=100)
.model BSS84P PMOS (VTO=-1.5)
.model DPROT D
.end`;
    const res = importSpiceNetlist(deck);
    expect(res.dropped).toHaveLength(0);

    const byId = new Map(res.components.map((c) => [c.id, c]));
    // BJT NPN model -> generic builtin (spice_model omitted).
    expect(byId.get("Q1")!.type).toBe("bjt");
    expect(byId.get("Q1")!.spiceModel).toBeNull();
    // PMOS model -> builtin PMOS (NOT the part name — that would be UNDEFINED_SPICE_MODEL).
    expect(byId.get("M1")!.type).toBe("mosfet");
    expect(byId.get("M1")!.spiceModel).toBe("PMOS");
    // diode -> generic builtin D (no part-number model).
    expect(byId.get("D1")!.type).toBe("diode");
    expect(byId.get("D1")!.spiceModel).toBeNull();

    // Crucially: the imported design has NO error diagnostics.
    const diags = validate(res.airXml);
    const errs = diags.filter((d) => d.severity === "error");
    expect(errs, JSON.stringify(errs)).toHaveLength(0);
  });

  it("never drops silently: unsupported constructs are reported with reasons", () => {
    const deck = `Unsupported
R1 a 0 1k
L1 a b 10uH
X1 a 0 MYSUB
.subckt MYSUB p n
R99 p n 1
.ends
.end`;
    const { dropped, components } = importSpiceNetlist(deck);
    expect(components.map((c) => c.id)).toContain("R1");
    // R99 lives inside the subckt body and must NOT leak in as a top-level part.
    expect(components.map((c) => c.id)).not.toContain("R99");
    const reasons = dropped.map((d) => d.reason).join(" | ");
    expect(reasons).toMatch(/inductor/i);
    expect(reasons).toMatch(/subcircuit|subckt/i);
  });

  it("continuation lines and inline comments are handled", () => {
    const deck = `Continuations
V1 vcc 0 DC
+ 5
R1 vcc 0 1k ; inline comment
.end`;
    const res = importSpiceNetlist(deck);
    expect(res.dropped).toHaveLength(0);
    const v1 = res.components.find((c) => c.id === "V1")!;
    expect(v1.value).toBe("5");
    expect(hasErrors(validate(res.airXml))).toBe(false);
  });
});

describe("Milestone M7: KiCad export → valid .kicad_sch", () => {
  const xml = `<system name="divider" ir_version="0.1">
    <metadata><title>Divider</title></metadata>
    <nets>
      <net id="gnd" role="ground"/>
      <net id="vcc" role="power"/>
      <net id="mid" role="signal"/>
    </nets>
    <components>
      <component id="R1" type="resistor"><value>1k</value><pin name="1" net="vcc"/><pin name="2" net="mid"/></component>
      <component id="R2" type="resistor"><value>2k</value><pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
      <component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="vcc"/><pin name="n" net="gnd"/></component>
    </components>
  </system>`;

  it("emits a structurally valid KiCad 8 document", () => {
    const res = exportKicad(parse(xml));
    expect(res.text.startsWith("(kicad_sch (version 20231120)")).toBe(true);
    expect(parensBalanced(res.text)).toBe(true);
    expect(res.symbols).toBe(3);
    expect(res.nets).toBe(3); // vcc, mid, gnd
    expect(res.pins).toBe(6); // 2+2+2
  });

  it("embeds lib_symbols so KiCad has no missing symbols", () => {
    const text = emitKicadSchematic(parse(xml));
    expect(text).toContain("(lib_symbols");
    // every instance lib_id must be defined in lib_symbols.
    const libIds = [...text.matchAll(/\(lib_id "([^"]+)"\)/g)].map((m) => m[1]);
    expect(libIds.length).toBe(3);
    for (const id of new Set(libIds)) {
      expect(text).toContain(`(symbol "${id}" (pin_names`);
    }
    // a symbol definition carries real pins.
    expect(text).toMatch(/\(pin passive line \(at /);
  });

  it("expresses every net as a connectable label", () => {
    const text = emitKicadSchematic(parse(xml));
    for (const net of ["vcc", "mid", "gnd"]) {
      expect(text).toContain(`(label "${net}"`);
    }
    // mid is shared by R1.2 and R2.1 -> at least two labels net it together.
    const midLabels = [...text.matchAll(/\(label "mid"/g)].length;
    expect(midLabels).toBeGreaterThanOrEqual(2);
  });

  it("round-trips: SPICE deck -> AIR -> KiCad, all consistent", () => {
    const airXml = parseSpiceNetlistToAirXml(`RT
R1 vcc mid 1k
R2 mid 0 2k
V1 vcc 0 DC 5
.end`);
    const res = exportKicad(parse(airXml));
    expect(parensBalanced(res.text)).toBe(true);
    expect(res.symbols).toBe(3);
    expect(res.text).toContain('(label "mid"');
  });
});
