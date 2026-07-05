/**
 * Error-mapping tests (issue #13 deliverable 5): ngspice stderr -> SimDiagnostic.
 * Covers the common failures documented in docs/sim_errors.md, one test each,
 * plus the "never swallow / classify unknown" behaviors.
 *
 * The stderr strings are representative of real ngspice output; the reproducing
 * netlist per code lives in docs/sim_errors.md and is exercised for real by the
 * Playwright error-path tests.
 */

import { describe, it, expect } from "vitest";
import { classifyStderr, hasError, UNCLASSIFIED_CODE } from "../../src/diagnostics";

describe("classifyStderr - common ngspice failures", () => {
  it("maps a singular matrix", () => {
    const d = classifyStderr("singular matrix:  check nodes mid and 3");
    expect(d).toHaveLength(1);
    expect(d[0]?.code).toBe("SIM-SINGULAR-MATRIX");
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.hint).toMatch(/ground|source/i);
    expect(d[0]?.raw).toContain("singular matrix");
  });

  it("maps timestep too small", () => {
    const d = classifyStderr(
      "Timestep too small; time = 1.2e-09, timestep = 1e-18: trouble with node vout",
    );
    expect(d[0]?.code).toBe("SIM-TIMESTEP-TOO-SMALL");
    expect(d[0]?.severity).toBe("error");
    expect(d[0]?.hint).toMatch(/reltol|resistance|snubber|discontinuity/i);
  });

  it("maps an unknown device", () => {
    const d = classifyStderr("Error: unknown device type: z1");
    expect(d[0]?.code).toBe("SIM-UNKNOWN-DEVICE");
  });

  it("maps a missing model", () => {
    const d = classifyStderr(
      "Error: unable to find definition of model nmos-missing",
    );
    expect(d[0]?.code).toBe("SIM-MODEL-NOT-FOUND");
  });

  it("maps a missing ground", () => {
    const d = classifyStderr("Error: circuit does not have a ground node");
    expect(d[0]?.code).toBe("SIM-GND-MISSING");
  });

  it("maps a parse error", () => {
    const d = classifyStderr("Error on line 7 : r1 a b : parse error");
    expect(d[0]?.code).toBe("SIM-PARSE-ERROR");
  });

  it("maps a DC convergence / gmin stepping failure", () => {
    const d = classifyStderr("Gmin stepping failed\nLast node voltages:");
    expect(d[0]?.code).toBe("SIM-GMIN-STEPPING-FAILED");
  });
});

describe("classifyStderr - robustness", () => {
  it("returns [] for benign chatter (warnings/notes only)", () => {
    const d = classifyStderr(
      "Warning: can't find the initialization file spinit.\nUsing SPARSE 1.3 as Direct Linear Solver",
    );
    expect(d).toEqual([]);
    expect(hasError(d)).toBe(false);
  });

  it("surfaces an unmapped error as UNCLASSIFIED rather than passing", () => {
    const d = classifyStderr("Error: some brand new failure mode we have not seen");
    expect(d).toHaveLength(1);
    expect(d[0]?.code).toBe(UNCLASSIFIED_CODE);
    expect(d[0]?.severity).toBe("error");
  });

  it("deduplicates repeated codes and is order-deterministic", () => {
    const blob = "singular matrix: nodes a\nsingular matrix: nodes b";
    const d = classifyStderr(blob);
    expect(d).toHaveLength(1);
    expect(d[0]?.code).toBe("SIM-SINGULAR-MATRIX");
  });

  it("classifies each of many mixed lines to a stable set", () => {
    const blob = [
      "Note: can't find the initialization file spinit.",
      "Timestep too small; time = 1e-9",
      "Warning: something benign",
    ].join("\n");
    const d = classifyStderr(blob);
    expect(d.map((x) => x.code)).toEqual(["SIM-TIMESTEP-TOO-SMALL"]);
  });
});
