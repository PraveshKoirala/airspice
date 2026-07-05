/**
 * Error-mapping browser tests (issue #13 deliverable 5): feed netlists that
 * provoke real ngspice failures and assert the structured SimDiagnostic code
 * reaches the client, AND that the raw stderr line was streamed (never
 * swallowed). These use the REAL engine, so they prove the mapping against real
 * ngspice output, not synthetic strings (the synthetic-string unit tests live in
 * tests/unit/diagnostics.test.ts). See docs/sim_errors.md.
 */

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __simlab?: unknown }).__simlab !== undefined);
  await page.evaluate(() => window.__simlab.preload());
});

// An isolated sub-network (R2 c d) whose nodes have no DC path to ground ->
// ngspice reports "singular matrix: check node c" (verified against the real
// engine). NOTE: line 1 of a SPICE deck is always the title and is ignored, so a
// real title comment is required or the first real line would be swallowed. This
// maps to SIM-SINGULAR-MATRIX and the raw line is streamed.
test("singular matrix maps to SIM-SINGULAR-MATRIX and streams stderr", async ({ page }) => {
  const netlist = `* singular: isolated subnet with no DC path to ground
V1 a 0 DC 5
R1 a 0 1k
R2 c d 1k
.op
.end`;
  const outcome = await page.evaluate(
    (n) => window.__simlab.run(n, []),
    netlist,
  );
  const streamed = [...outcome.stdout, ...outcome.stderr].join("\n").toLowerCase();
  expect(
    outcome.errorCode,
    `errorCode=${outcome.errorCode}\nstderr:\n${outcome.stderr.join("\n")}\nstdout:\n${outcome.stdout.join("\n")}`,
  ).toBe("SIM-SINGULAR-MATRIX");
  expect(streamed).toContain("singular matrix");
});

// Unknown device type letter.
test("unknown device maps to an error and streams stderr", async ({ page }) => {
  const netlist = `* unknown device prefix Z
V1 a 0 DC 5
Z1 a 0 bogus
.op
.end`;
  const outcome = await page.evaluate((n) => window.__simlab.run(n, []), netlist);
  expect(outcome.errorCode).not.toBeNull();
  expect(outcome.stderr.length).toBeGreaterThan(0);
});

// A device referencing an undefined model.
test("missing model maps to an error and streams stderr", async ({ page }) => {
  const netlist = `* MOSFET with no .model
V1 d 0 DC 5
M1 d g 0 0 MISSINGMODEL
Vg g 0 DC 2
.op
.end`;
  const outcome = await page.evaluate((n) => window.__simlab.run(n, []), netlist);
  expect(outcome.errorCode).not.toBeNull();
  expect(outcome.stderr.length).toBeGreaterThan(0);
});

// stderr is NEVER swallowed even on a SUCCESSFUL run: benign notes stream too.
test("stderr/stdout lines stream even for a healthy run", async ({ page }) => {
  const netlist = `* healthy divider
V1 vin 0 DC 5
R1 vin mid 10k
R2 mid 0 10k
.tran 1u 1m
.end`;
  const outcome = await page.evaluate((n) => window.__simlab.run(n, ["v(mid)"]), netlist);
  expect(outcome.errorCode).toBeNull();
  // The engine transcript (stdout) is non-empty -> output is surfaced, not eaten.
  expect(outcome.stdout.length + outcome.stderr.length).toBeGreaterThan(0);
});
