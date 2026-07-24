/**
 * Pure canvas draw primitives for the waveform viewer (issue #25).
 *
 * Split out of the React component so the SAME code path renders in a
 * production canvas and in an OffscreenCanvas inside a unit test — the
 * spike-preservation test (deliverable 8) opens an OffscreenCanvas, calls
 * `drawTrace` with a 100k-sample trace containing a single 1-sample spike,
 * and asserts the spike's pixel is lit. That test is only meaningful if the
 * viewer draws through the same function.
 *
 * All primitives take a `CanvasRenderingContext2D`-compatible object (the
 * OffscreenCanvas 2D context is structurally compatible), take a `Plot` for
 * the coordinate mapping, and never touch the DOM — no `getComputedStyle`,
 * no CSS variables read at draw time, no ResizeObserver in the hot path.
 */

import { isEmpty, LodCache } from "./decimation";
import { formatTick, formatTime, niceTickStep, tickPositions } from "./units";

/** The plot's coordinate mapping — how time/value map to canvas x/y. */
export interface Plot {
  /** Plot area in canvas coordinates (device pixels). */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Visible time window (seconds). */
  tMin: number;
  tMax: number;
  /** Visible value window (volts or amps — the trace decides). */
  vMin: number;
  vMax: number;
}

/** Convert time to canvas x. */
export function timeToX(p: Plot, t: number): number {
  return p.x0 + ((t - p.tMin) / (p.tMax - p.tMin || 1)) * p.width;
}
/** Convert value to canvas y (y inverted — larger values are HIGHER). */
export function valueToY(p: Plot, v: number): number {
  return p.y0 + (1 - (v - p.vMin) / (p.vMax - p.vMin || 1)) * p.height;
}
/** Convert canvas x back to time. */
export function xToTime(p: Plot, x: number): number {
  return p.tMin + ((x - p.x0) / p.width) * (p.tMax - p.tMin);
}
/** Convert canvas y back to value. */
export function yToValue(p: Plot, y: number): number {
  return p.vMax - ((y - p.y0) / p.height) * (p.vMax - p.vMin);
}

/**
 * The subset of `CanvasRenderingContext2D` we use. Kept as a local interface
 * so the module has ZERO dependency on the DOM lib beyond what a headless
 * OffscreenCanvas 2D context already provides. The signatures match the
 * standard exactly; we're just narrowing the surface so the tests can pass
 * an OffscreenCanvas context in without a `// @ts-expect-error`.
 */
export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Style knobs; passed by the viewer so both themes render through here. */
export interface Style {
  bg: string;
  axis: string;
  axisText: string;
  gridMinor: string;
  gridMajor: string;
  cursor: string;
  assertionBandPass: string;
  assertionBandFail: string;
}

/** Default palette (dark theme; the viewer overrides for the light theme). */
export const DEFAULT_STYLE: Style = {
  bg: "#0b1120",
  axis: "#475569",
  axisText: "#f8fafc",
  gridMinor: "rgba(255, 255, 255, 0.03)",
  gridMajor: "rgba(255, 255, 255, 0.08)",
  cursor: "#38bdf8",
  assertionBandPass: "rgba(16, 185, 129, 0.10)",
  assertionBandFail: "rgba(244, 63, 94, 0.25)",
};

/** Clear the plot region with the background color. */
export function drawBackground(ctx: Ctx, p: Plot, style: Style): void {
  ctx.fillStyle = style.bg;
  ctx.fillRect(p.x0, p.y0, p.width, p.height);
}

/**
 * Draw a min/max-decimated trace. The critical property: every column's bar
 * goes from `min` to `max` INCLUSIVE, so a one-sample spike is a segment at
 * least 1 pixel tall — never invisible. When min == max (flat column), we
 * draw a 1-pixel segment so the trace stays visible.
 */
export function drawTrace(
  ctx: Ctx,
  p: Plot,
  cache: LodCache,
  color: string,
): void {
  const cols = Math.max(1, Math.floor(p.width));
  const buckets = cache.decimate(p.tMin, p.tMax, cols);

  ctx.save();
  // Clip to the plot area so a trace whose Y range exceeds vMin/vMax never
  // draws over the axis or the neighbor stack.
  ctx.beginPath();
  ctx.rect(p.x0, p.y0, p.width, p.height);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  // Draw as batched vertical segments; `stroke()` once for the whole batch
  // to minimize GPU state changes. On a 1M-point trace at 800 columns this
  // is 800 line segments per frame, well inside the 16ms budget.
  ctx.beginPath();
  for (let c = 0; c < cols; c++) {
    const b = buckets[c]!;
    if (isEmpty(b)) continue;
    const x = p.x0 + c + 0.5; // pixel-center alignment for a crisp 1px line
    const yTop = valueToY(p, b.max);
    let yBot = valueToY(p, b.min);
    // Ensure at least 1 pixel of vertical coverage so a flat column is drawn.
    if (Math.abs(yBot - yTop) < 1) yBot = yTop + 1;
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yBot);
  }
  ctx.stroke();

  ctx.restore();
}

/** Draw the plot border + gridlines + axis labels. */
export function drawAxes(
  ctx: Ctx,
  p: Plot,
  style: Style,
  unit: string,
): void {
  ctx.save();
  ctx.strokeStyle = style.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(p.x0 + 0.5, p.y0 + 0.5, p.width - 1, p.height - 1);

  // Gridlines — light strokes at "nice" tick positions.
  const tStep = niceTickStep(p.tMax - p.tMin, p.width, 90);
  const vStep = niceTickStep(p.vMax - p.vMin, p.height, 40);
  const tTicks = tickPositions(p.tMin, p.tMax, tStep);
  const vTicks = tickPositions(p.vMin, p.vMax, vStep);

  ctx.strokeStyle = style.gridMinor;
  ctx.beginPath();
  for (const t of tTicks) {
    const x = Math.round(timeToX(p, t)) + 0.5;
    ctx.moveTo(x, p.y0);
    ctx.lineTo(x, p.y0 + p.height);
  }
  for (const v of vTicks) {
    const y = Math.round(valueToY(p, v)) + 0.5;
    ctx.moveTo(p.x0, y);
    ctx.lineTo(p.x0 + p.width, y);
  }
  ctx.stroke();

  // Labels — small, high contrast; drawn OUTSIDE the plot area so trace
  // pixels never overlap them.
  ctx.fillStyle = style.axisText;
  ctx.font = "12px system-ui, -apple-system, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "center";
  for (const t of tTicks) {
    const x = timeToX(p, t);
    ctx.fillText(formatTime(t), x, p.y0 + p.height + 4);
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const v of vTicks) {
    const y = valueToY(p, v);
    ctx.fillText(`${formatTick(v)}${unit}`, p.x0 - 4, y);
  }
  ctx.restore();
}

/**
 * Shade the assertion min/max band (light green when the trace stays inside
 * the band; light red on any column where the observed min/max escapes the
 * band). This is deliverable 6 — the "why did my check fail" view.
 *
 * `cache` and the column bucketing are re-used from `drawTrace` so a failing
 * region lines up with the exact columns where samples went out of range.
 */
export function drawAssertionBand(
  ctx: Ctx,
  p: Plot,
  cache: LodCache,
  bandMin: number | null,
  bandMax: number | null,
  style: Style,
): void {
  if (bandMin === null && bandMax === null) return;
  const cols = Math.max(1, Math.floor(p.width));
  const buckets = cache.decimate(p.tMin, p.tMax, cols);

  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x0, p.y0, p.width, p.height);
  ctx.clip();

  // Pass band — one broad rect across the whole visible X. Uses the more
  // restrictive of the plot Y window vs. the band Y window so the shading
  // stays inside the plot area on a zoomed-in Y.
  const yTop = valueToY(p, bandMax ?? p.vMax);
  const yBot = valueToY(p, bandMin ?? p.vMin);
  const passRectY = Math.min(yTop, yBot);
  const passRectH = Math.abs(yBot - yTop);
  ctx.fillStyle = style.assertionBandPass;
  ctx.fillRect(p.x0, passRectY, p.width, passRectH);

  // Failing columns — where the observed [bucket.min, bucket.max] escapes
  // the assertion band. Highlighted as a full-height vertical stripe so a
  // narrow-column violation is unmissable at zoom-out.
  ctx.fillStyle = style.assertionBandFail;
  for (let c = 0; c < cols; c++) {
    const b = buckets[c]!;
    if (isEmpty(b)) continue;
    const fails =
      (bandMin !== null && b.min < bandMin) ||
      (bandMax !== null && b.max > bandMax);
    if (!fails) continue;
    ctx.fillRect(p.x0 + c, p.y0, 1, p.height);
  }
  ctx.restore();
}

/** Draw a single vertical cursor. Called twice for the two cursors. */
export function drawCursor(ctx: Ctx, p: Plot, t: number, style: Style, label?: string): void {
  if (!Number.isFinite(t)) return;
  if (t < p.tMin || t > p.tMax) return;
  ctx.save();
  const x = Math.round(timeToX(p, t)) + 0.5;
  ctx.strokeStyle = style.cursor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, p.y0);
  ctx.lineTo(x, p.y0 + p.height);
  ctx.stroke();
  ctx.setLineDash([]);
  if (label) {
    ctx.fillStyle = style.cursor;
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(label, x + 4, p.y0 + 4);
  }
  ctx.restore();
}

/**
 * Draw the box-zoom rubber-band. `null`s mean "not dragging". Kept trivial
 * because the box-zoom feedback layer is redrawn every mousemove.
 */
export function drawZoomBox(ctx: Ctx, p: Plot, x0: number, y0: number, x1: number, y1: number, style: Style): void {
  ctx.save();
  ctx.strokeStyle = style.cursor;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  const lx = Math.min(x0, x1);
  const ly = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  ctx.strokeRect(Math.floor(lx) + 0.5, Math.floor(ly) + 0.5, Math.floor(w), Math.floor(h));
  ctx.restore();
  // The `p` parameter is accepted for future clip-to-plot changes; keep the
  // signature stable.
  void p;
}
