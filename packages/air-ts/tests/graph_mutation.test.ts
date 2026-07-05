/**
 * Emitter mutation / self-test for the graph emitter (issue #10, "same
 * discipline as #7/#8"). The corpus parity suite proves byte-parity for the 15
 * designs, but the corpus never exercises three emitter behaviours -- so this
 * file proves them live, and proves the emitter reacts to real input changes
 * (a byte-parity suite that ignored its input would still pass).
 *
 *   1. Implicit-net path: a pin referencing a net NOT declared in <nets>. The
 *      oracle synthesizes a net node with `implicit: true` and an INFERRED role
 *      (`_infer_net_role`). No corpus design hits this (grep 'implicit' over the
 *      corpus graph.json files finds nothing).
 *   2. inferNetRole classification: ground / power / signal buckets.
 *   3. Ordering contract: node `pins` array sorted by name, but `edges` in
 *      DOCUMENT (pin insertion) order -- the two orders visibly differ.
 *
 * No golden-corpus design NAME appears here (guardrails R4 / AGENTS.md rule 13);
 * the base XML is synthetic and lives under tests/.
 */

import { describe, it, expect } from "vitest";
import { toGraph, inferNetRole, type GraphData } from "../src/index.js";

/** A tiny synthetic design used as the mutation base. */
const BASE = `<system name="emit_base" ir_version="0.1">
  <metadata><title>Emit base</title></metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vcc" role="power" nominal_voltage="5V"/>
    <net id="sig" role="analog_signal"/>
  </nets>
  <components>
    <component id="R1" type="resistor">
      <value>10k</value>
      <pin name="2" net="sig"/>
      <pin name="1" net="vcc"/>
    </component>
    <component id="C1" type="capacitor">
      <value>100nF</value>
      <pin name="1" net="sig"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <tests/>
  <simulation_profiles/>
</system>`;

interface NodeShape {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
interface EdgeShape {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  label: string;
  data: { pin: string; net: string };
}

function graph(xml: string): { nodes: NodeShape[]; edges: EdgeShape[] } {
  const g: GraphData = toGraph(xml);
  return { nodes: g.nodes as unknown as NodeShape[], edges: g.edges as unknown as EdgeShape[] };
}

function nodeById(g: { nodes: NodeShape[] }, id: string): NodeShape {
  const n = g.nodes.find((x) => x.id === id);
  expect(n, `node ${id} present`).toBeTruthy();
  return n as NodeShape;
}

describe("graph emitter: base structure", () => {
  const g = graph(BASE);

  it("emits a component node per component and a net node per net", () => {
    const componentNodes = g.nodes.filter((n) => n.type === "component").map((n) => n.id);
    const netNodes = g.nodes.filter((n) => n.type === "net").map((n) => n.id);
    expect(componentNodes).toEqual(["C1", "R1"]); // id-sorted, components first
    expect(netNodes).toEqual(["net:gnd", "net:sig", "net:vcc"]); // id-sorted
  });

  it("component nodes precede net nodes in the nodes array", () => {
    const firstNetIndex = g.nodes.findIndex((n) => n.type === "net");
    const lastComponentIndex =
      g.nodes.length - 1 - [...g.nodes].reverse().findIndex((n) => n.type === "component");
    expect(lastComponentIndex).toBeLessThan(firstNetIndex);
  });

  it("net node carries the DECLARED role verbatim (not inferred)", () => {
    // sig is declared role=analog_signal; the inferred role would be 'signal'.
    expect((nodeById(g, "net:sig").data as { role: string }).role).toBe("analog_signal");
    expect(inferNetRole("sig")).toBe("signal"); // proves it is NOT the inference path
    expect((nodeById(g, "net:vcc").data as { role: string }).role).toBe("power");
    expect((nodeById(g, "net:gnd").data as { role: string }).role).toBe("ground");
  });

  it("declared net nodes have no implicit flag", () => {
    for (const n of g.nodes.filter((x) => x.type === "net")) {
      expect("implicit" in n.data).toBe(false);
    }
  });
});

describe("graph emitter: ordering contract", () => {
  const g = graph(BASE);

  it("node.pins is sorted by pin NAME", () => {
    const r1 = nodeById(g, "R1");
    const pinNames = (r1.data.pins as Array<{ name: string }>).map((p) => p.name);
    expect(pinNames).toEqual(["1", "2"]); // sorted, though the XML lists 2 then 1
  });

  it("edges for a component are in DOCUMENT (pin insertion) order", () => {
    // R1's XML lists pin "2" before pin "1"; edges must follow that order,
    // which differs from the sorted node.pins order above.
    const r1Edges = g.edges.filter((e) => e.source === "R1").map((e) => e.label);
    expect(r1Edges).toEqual(["2", "1"]);
  });

  it("edges are grouped by id-sorted component", () => {
    const sources = g.edges.map((e) => e.source);
    // All C1 edges then all R1 edges (C1 < R1 by code point).
    const firstR1 = sources.indexOf("R1");
    const lastC1 = sources.lastIndexOf("C1");
    expect(lastC1).toBeLessThan(firstR1);
  });
});

describe("graph emitter: edge metadata", () => {
  const g = graph(BASE);
  const edge = g.edges.find((e) => e.source === "R1" && e.label === "1") as EdgeShape;

  it("edge id / handles / data mirror the oracle format", () => {
    expect(edge.id).toBe("R1:1->vcc");
    expect(edge.source).toBe("R1");
    expect(edge.target).toBe("net:vcc");
    expect(edge.sourceHandle).toBe("pin:1");
    expect(edge.targetHandle).toBe("net");
    expect(edge.data).toEqual({ pin: "1", net: "vcc" });
  });
});

describe("graph emitter: reacts to input mutations", () => {
  it("adding a component adds a component node and its edges", () => {
    const before = graph(BASE);
    const mutated = BASE.replace(
      "</components>",
      `  <component id="R2" type="resistor">
      <value>1k</value>
      <pin name="1" net="vcc"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>`,
    );
    const after = graph(mutated);
    expect(after.nodes.filter((n) => n.type === "component").length).toBe(
      before.nodes.filter((n) => n.type === "component").length + 1,
    );
    expect(after.edges.filter((e) => e.source === "R2").map((e) => e.label)).toEqual(["1", "2"]);
    expect(nodeById(after, "R2")).toBeTruthy();
  });

  it("changing a component value changes the node data", () => {
    const mutated = BASE.replace("<value>10k</value>", "<value>47k</value>");
    const r1 = nodeById(graph(mutated), "R1");
    expect((r1.data as { value: string }).value).toBe("47k");
  });
});

describe("graph emitter: implicit-net path (uncovered by corpus)", () => {
  // Point a pin at a net NOT declared in <nets>. The oracle synthesizes a net
  // node with implicit:true and an inferred role.
  const withImplicit = BASE.replace('<pin name="2" net="gnd"/>', '<pin name="2" net="0"/>');
  const g = graph(withImplicit);

  it("synthesizes a net node for the undeclared net", () => {
    const implicitNet = nodeById(g, "net:0");
    expect(implicitNet.type).toBe("net");
  });

  it("marks the synthesized net implicit and infers its role", () => {
    const data = nodeById(g, "net:0").data as { role: string; implicit?: boolean };
    expect(data.implicit).toBe(true);
    expect(data.role).toBe("ground"); // "0" -> ground via inferNetRole
  });

  it("still emits the edge to the implicit net", () => {
    const e = g.edges.find((x) => x.source === "C1" && x.target === "net:0");
    expect(e, "edge to implicit net present").toBeTruthy();
    expect((e as EdgeShape).data).toEqual({ pin: "2", net: "0" });
  });
});

describe("graph emitter: inferNetRole classification", () => {
  it.each([
    ["gnd", "ground"],
    ["GROUND", "ground"],
    ["0", "ground"],
    ["vss", "ground"],
    ["vcc", "power"],
    ["VDD", "power"],
    ["vin", "power"],
    ["bat", "power"],
    ["3v3", "power"],
    ["+5V", "power"],
    ["some_signal", "signal"],
    ["", "signal"],
  ])("inferNetRole(%s) === %s", (id, role) => {
    expect(inferNetRole(id)).toBe(role);
  });
});

describe("graph emitter: empty-string collapse", () => {
  it("absent part/value/spice_model and pin function collapse to ''", () => {
    // R1 has value but no part/spice_model; its pins have no function.
    const r1 = nodeById(graph(BASE), "R1");
    const data = r1.data as {
      part: string;
      value: string;
      spice_model: string;
      pins: Array<{ function: string }>;
    };
    expect(data.part).toBe("");
    expect(data.spice_model).toBe("");
    expect(data.value).toBe("10k");
    for (const p of data.pins) expect(p.function).toBe("");
  });
});
