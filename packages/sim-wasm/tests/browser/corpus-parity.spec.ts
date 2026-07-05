/**
 * Corpus-netlist parity (issue #13 deliverable 8; acceptance: divider in Chrome
 * AND Firefox, final node voltages within rtol 1e-3).
 *
 * For each selected corpus design we run its ACTUAL netlist.cir through the real
 * WASM ngspice engine in a real Web Worker and assert the final voltage of every
 * node against the corpus report's `measurements` (Python oracle + native
 * ngspice). rtol comes from the JSON case list. Numbers are read from fixtures,
 * never hand-copied.
 */

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCorpusCases } from "./corpus";

const CASE_CONFIG = JSON.parse(
  readFileSync(fileURLToPath(new URL("./corpus-cases.json", import.meta.url)), "utf-8"),
) as { designs: string[]; rtol: number };

const CASES = loadCorpusCases(CASE_CONFIG.designs);
const RTOL = CASE_CONFIG.rtol;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // Wait for the harness to warm the engine (preload resolves capabilities).
  await page.waitForFunction(() => (window as unknown as { __simlab?: unknown }).__simlab !== undefined);
  const caps = await page.evaluate(() => window.__simlab.preload());
  expect(caps.control).toBe(false); // eecircuit is fire-and-forget (ADR 0011)
  expect(caps.engine).toBe("eecircuit-engine");
});

for (const c of CASES) {
  test(`corpus parity: ${c.design} final node voltages within rtol ${RTOL}`, async ({ page }) => {
    const probes = Object.keys(c.expectedVolts).map((n) => `v(${n})`);
    const outcome = await page.evaluate(
      ({ netlist, probeVectors }) => window.__simlab.run(netlist, probeVectors),
      { netlist: c.netlist, probeVectors: probes },
    );

    // The run must not have errored.
    expect(outcome.errorCode, `stderr:\n${outcome.stderr.join("\n")}`).toBeNull();

    // Assert each expected node voltage. ngspice reports v(node) lower-cased.
    const report: string[] = [];
    for (const [node, expected] of Object.entries(c.expectedVolts)) {
      const key = `v(${node})`;
      const actual = outcome.finals[key];
      expect(actual, `missing vector ${key}; got ${Object.keys(outcome.finals).join(", ")}`)
        .toBeDefined();
      const tol = Math.max(Math.abs(expected) * RTOL, 1e-9);
      report.push(`${node}: expected=${expected} actual=${actual} tol=${tol}`);
      expect(Math.abs((actual as number) - expected), report.join("\n")).toBeLessThanOrEqual(tol);
    }
  });
}

test("engine advertises capabilities.control=false (forward-compat hook)", async ({ page }) => {
  const caps = await page.evaluate(() => window.__simlab.preload());
  expect(caps).toMatchObject({ control: false, engine: "eecircuit-engine" });
  expect(caps.ngspiceVersion).toBeTruthy();
});
