/**
 * Result-conversion tests: eecircuit ResultType -> transferable WaveTable[].
 * Verifies unit mapping, Float64Array transfer buffers, probe filtering/order,
 * and the finalValue helper the corpus-parity tests rely on.
 */

import { describe, it, expect } from "vitest";
import { toWaveTables, finalValue } from "../../src/result";

const RAW = {
  dataType: "real",
  variableNames: ["time", "v(mid)", "v(vin)"],
  data: [
    { name: "time", type: "time", values: [0, 1e-3, 2e-3] },
    { name: "v(mid)", type: "voltage", values: [2.5, 2.5, 2.5] },
    { name: "v(vin)", type: "voltage", values: [5, 5, 5] },
  ],
};

describe("toWaveTables", () => {
  it("maps every vector when no probes are given", () => {
    const { tables, transfer } = toWaveTables(RAW);
    expect(tables.map((t) => t.name)).toEqual(["time", "v(mid)", "v(vin)"]);
    expect(tables[0]?.unit).toBe("time");
    expect(tables[1]?.unit).toBe("voltage");
    expect(tables[1]?.values).toBeInstanceOf(Float64Array);
    // One transferable buffer per table.
    expect(transfer).toHaveLength(3);
    expect(transfer[0]).toBe(tables[0]?.values.buffer);
  });

  it("filters and orders by probe vector (case-insensitive)", () => {
    const { tables } = toWaveTables(RAW, [
      { id: "b", vector: "V(VIN)" },
      { id: "a", vector: "v(mid)" },
    ]);
    expect(tables.map((t) => t.name)).toEqual(["v(vin)", "v(mid)"]);
  });

  it("flattens complex values to their real part", () => {
    const complexRaw = {
      dataType: "complex",
      data: [
        { name: "v(out)", type: "voltage", values: [{ real: 1.5, img: 0.2 }] },
      ],
    };
    const { tables } = toWaveTables(complexRaw);
    expect(tables[0]?.values[0]).toBeCloseTo(1.5, 9);
  });
});

describe("finalValue", () => {
  it("returns the last sample of a named vector, case-insensitively", () => {
    const { tables } = toWaveTables(RAW);
    expect(finalValue(tables, "v(mid)")).toBe(2.5);
    expect(finalValue(tables, "V(VIN)")).toBe(5);
  });

  it("returns NaN for an absent vector", () => {
    const { tables } = toWaveTables(RAW);
    expect(Number.isNaN(finalValue(tables, "v(nope)"))).toBe(true);
  });
});
