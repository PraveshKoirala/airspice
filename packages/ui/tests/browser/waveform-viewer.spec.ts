/**
 * Waveform viewer v2 acceptance tests (issue #25).
 *
 * Three orthogonal checks, driven through the harness page
 * (`tests/browser/harness/waveform.html`):
 *
 *   1. Spike preservation (deliverable 8): a one-sample spike in a 100k-sample
 *      trace remains visible at whole-range zoom-out. The test renders into an
 *      OffscreenCanvas at plot width 800 (so one column covers ~125 samples),
 *      then reads pixel data along the spike's column and asserts >= 20 rows
 *      of the 200-pixel-tall plot are lit. A stride-subsampled implementation
 *      would drop the spike and the column would show baseline coverage only.
 *
 *   2. 1M-point perf (deliverable 7): builds the LOD cache once (out of the
 *      per-frame budget), then pans 60 frames across a 1M-point sine and
 *      asserts the median per-frame render time stays under 16ms. The full
 *      timing table lands in the PR body.
 *
 *   3. Cursors + assertion overlay (deliverables 4, 6): mounts the real
 *      React viewer with a synthesized trace + a design carrying a failing
 *      `assert_voltage`, then confirms the failing-assertion data-testid is
 *      emitted so a UI/repair flow can link back to it.
 */

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/browser/harness/waveform.html');
  await page.waitForFunction(() => (window as unknown as { __wf?: unknown }).__wf !== undefined);
});

test("min/max decimation preserves a 1-sample spike in a 100k trace at zoom-out", async ({ page }) => {
  // A stride-subsampled implementation would MISS a 1-in-100k spike at width
  // 800 (bucket size ~125 samples): if the stride hop is (say) every 125th
  // sample, the spike must land ON a stride point to be drawn. With min/max
  // decimation the spike lives inside SOME bucket and its extremum survives.
  //
  // Place the spike well inside the range so it's not clipped to the left
  // axis label or the right-hand end of the canvas.
  const result = await page.evaluate(() => window.__wf.spikeTest(800, 200, 51234));

  // Log the result so a PR reviewer can see the exact pixel spread.
  console.log(`SPIKE TEST result: ${JSON.stringify(result)}`);

  expect(
    result.spikePixelLit,
    `spike at column ${result.spikeColumn} should light at least 20 vertical pixels; got y=[${result.spikeMinY}, ${result.spikeMaxY}]`,
  ).toBe(true);
  // The lit-columns list must contain the spike's column; if it's empty the
  // trace didn't draw at all.
  expect(result.litColumns).toContain(result.spikeColumn);
});

test("1M-point trace pans at interactive rate (median frame < 16ms)", async ({ page }) => {
  const result = await page.evaluate(() => window.__wf.benchPan(1_000_000, 60, 900, 200));

  console.log(`BENCH PAN result: ${JSON.stringify(result)}`);

  // The acceptance criterion is "1M-point synthetic trace pans at interactive
  // rate". We target < 16ms per frame after the cache is warm. If a JIT tier
  // drift bumps a single frame over 16ms it should still be well below 32ms,
  // so we assert the MEDIAN frame time (robust to a single outlier).
  expect(
    result.medianFrameMs,
    `median frame time must be < 16ms; got ${result.medianFrameMs.toFixed(2)}ms (max ${result.maxFrameMs.toFixed(2)}ms)`,
  ).toBeLessThan(16);
});

test("assertion overlay emits a data-testid for a FAILED assertion", async ({ page }) => {
  // A minimal AIR design with one assert_voltage that a flat trace will
  // trivially violate. The viewer's assertion band code must emit the
  // `waveform-assertion-<key>-failed` data-testid so the UI/repair flow can
  // link a failing region back to its diagnostic.
  const designXml = `<?xml version="1.0" encoding="UTF-8"?>
<system name="test" ir_version="0.1">
  <metadata><title>Test</title><description>Test</description><author>t</author><created_at>2026-01-01T00:00:00Z</created_at></metadata>
  <nets><net id="gnd" role="ground"/><net id="probe" role="analog_signal"/></nets>
  <components>
    <component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="probe"/><pin name="n" net="gnd"/></component>
  </components>
  <tests>
    <test id="t1">
      <setup/>
      <run duration="1ms"/>
      <assert_voltage net="probe" min="2V" max="3V"/>
    </test>
  </tests>
</system>`;

  // A flat trace at 5V that violates the [2V, 3V] band.
  const time = Array.from({ length: 1000 }, (_, i) => i * 1e-6);
  const values = Array.from({ length: 1000 }, () => 5.0);

  const result = await page.evaluate(
    ({ designXml, time, values }) =>
      window.__wf.renderViewer({
        traces: [
          {
            key: "t1_probe",
            label: "probe (V) - t1",
            net: "probe",
            test: "t1",
            unit: "V",
            time,
            values,
          },
        ],
        designXml,
        // Simulate a report with a failing assertion so the viewer knows to
        // mark the band as failed.
        diagnostics: [
          {
            code: "ASSERT_FAILED",
            id: "diag_00001",
            related_elements: ["t1", "probe"],
          },
        ],
      }),
    { designXml, time, values },
  );

  console.log(`ASSERTION OVERLAY selectors: ${JSON.stringify(result.assertionSelectors)}`);

  expect(result.hasCanvas, "the viewer must mount a canvas element").toBe(true);
  expect(
    result.assertionSelectors.some((s) => s.endsWith("-failed")),
    `expected a "-failed" assertion selector; got ${result.assertionSelectors.join(", ")}`,
  ).toBe(true);
});

test("cursor readout is present after mounting the viewer with traces", async ({ page }) => {
  // A simple two-trace mount + a cursor click. This exercises the cursor
  // report table's data-testid + the Δt / 1/Δt labels the acceptance list
  // pins.
  const time = Array.from({ length: 500 }, (_, i) => i * 1e-6);
  const values = Array.from({ length: 500 }, (_, i) => Math.sin((i / 500) * Math.PI * 4));

  await page.evaluate(
    ({ time, values }) =>
      window.__wf.renderViewer({
        traces: [
          {
            key: "t1_a",
            label: "a (V) - t1",
            net: "a",
            test: "t1",
            unit: "V",
            time,
            values,
          },
        ],
      }),
    { time, values },
  );

  // Click twice to place both cursors (the viewer's placeCursor treats a
  // click as cursor A and a shift-click as cursor B).
  const canvas = page.getByTestId("waveform-canvas");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({ position: { x: box!.width * 0.3, y: box!.height * 0.5 } });
  await canvas.click({ position: { x: box!.width * 0.7, y: box!.height * 0.5 }, modifiers: ["Shift"] });

  const report = page.getByTestId("waveform-cursor-report");
  await expect(report).toBeVisible();
  await expect(page.getByTestId("waveform-cursor-dt")).toBeVisible();
  await expect(page.getByTestId("waveform-cursor-freq")).toBeVisible();
});
