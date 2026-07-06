/**
 * Waveform viewer v2 (issue #25).
 *
 * A canvas-based, scope-grade waveform panel with:
 *   - min/max per-pixel-column decimation (deliverable 2 — the spike-preserve
 *     invariant); LOD cache per trace (deliverable 7 — 1M-point pans at
 *     interactive rate after the cache is warm).
 *   - wheel zoom cursor-anchored, drag pan, box-zoom, double-click reset
 *     (deliverable 3).
 *   - two vertical cursors reporting per-trace value, Δt, Δv, 1/Δt
 *     (deliverable 4); snap-to-sample.
 *   - trace show/hide + deterministic colors + unit-aware axis + engineering
 *     ticks (deliverable 3, 5).
 *   - assertion overlay: shaded pass band, failing regions flagged
 *     (deliverable 6). Each shaded region carries a `data-testid` linking it
 *     to the assertion diagnostic (per the audit amendment).
 *
 * NO charting library. The whole viewer draws through the primitives in
 * `render.ts`; the React component's job is state + input events.
 *
 * INVARIANTS:
 *   - Waveforms are DISPLAY (issue #96): this component never writes design
 *     state; it only reads the retained typed arrays from the waveform store.
 *   - Zero-backend gate holds: waveforms come from the local report pipeline
 *     (#14); the server path is untouched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseQuantity, waveformCsv } from "air-ts";
import type { SystemIR } from "air-ts";
import { LodCache } from "./decimation";
import {
  DEFAULT_STYLE,
  drawAssertionBand,
  drawAxes,
  drawBackground,
  drawCursor,
  drawTrace,
  drawZoomBox,
  timeToX,
  xToTime,
  type Plot,
  type Style,
} from "./render";
import { formatTime, formatValueUnit } from "./units";
import { colorForKey } from "./palette";

/** One trace passed to the viewer. `time`/`values` MUST be Float64Array (#14). */
export interface WaveformTrace {
  /** Stable key `${test}_${net}` — used for color hash + data-testid. */
  key: string;
  /** Human label for the trace legend ("battery_sense (V) — test_id"). */
  label: string;
  /** Probed net name ("battery_sense", "3v3"). */
  net: string;
  /** Test id this trace belongs to (assertions live under the test). */
  test: string;
  /** "V" or "A" — drives the axis label + cursor readout unit. */
  unit: "V" | "A";
  time: Float64Array;
  values: Float64Array;
}

/**
 * An assertion band (min/max) applied to a trace's Y axis. `min`/`max` may be
 * null (default -1e99 / 1e99 in the report — no band edge). `diagnosticId` is
 * present for a FAILED assertion so the shaded region can carry the id link.
 */
export interface AssertionBand {
  traceKey: string;
  min: number | null;
  max: number | null;
  /** `diag_00001` if the assertion failed; empty for a passing band. */
  diagnosticId: string;
  /** True on failure — the viewer flags failing columns unconditionally, but
   *  the sidebar summary uses this to prioritize display order. */
  failed: boolean;
}

export interface WaveformViewerProps {
  traces: WaveformTrace[];
  /** Optional parsed design IR — the viewer extracts assertions from it. */
  design?: SystemIR | null;
  /** Optional diagnostics from the report — used to mark failed assertions. */
  diagnostics?: Array<{ code: string; id?: string; related_elements?: string[] }>;
  /** Height per stacked trace in CSS pixels. Defaults to 200. */
  perTraceHeight?: number;
  /** Theme (dark = default palette; light overrides colors). */
  theme?: "dark" | "light";
}

/** Column-major layout: left gutter for Y labels, bottom gutter for X labels. */
const LEFT_PAD = 68;
const RIGHT_PAD = 16;
const TOP_PAD = 12;
const BOTTOM_PAD = 26;
const LEGEND_HEIGHT = 34;

interface CursorState {
  a: number | null;
  b: number | null;
}

interface DragState {
  kind: "pan" | "box" | null;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startTMin: number;
  startTMax: number;
  laneIndex: number;
}

interface Lane {
  key: string;
  trace: WaveformTrace;
  cache: LodCache;
  vMin: number;
  vMax: number;
  /** Manual Y override; `null` means "auto-scale from cache global min/max". */
  manualY: [number, number] | null;
  visible: boolean;
  color: string;
}

/** Light theme overrides — kept explicit so the canvas never reads CSS. */
const LIGHT_STYLE: Style = {
  bg: "#ffffff",
  axis: "#475569",
  axisText: "#0f172a",
  gridMinor: "rgba(15, 23, 42, 0.05)",
  gridMajor: "rgba(15, 23, 42, 0.12)",
  cursor: "#b45309",
  assertionBandPass: "rgba(22, 163, 74, 0.10)",
  assertionBandFail: "rgba(220, 38, 38, 0.28)",
};

/**
 * Extract assertion bands from the parsed design IR. Each `assert_voltage` /
 * `assert_current` becomes a band keyed by `${test}_${net}` (voltage) or
 * `${test}_i(${component})` (current). Matches the report's `evaluateAssertions`
 * subject convention.
 */
function extractBands(
  design: SystemIR | null | undefined,
  diagnostics: WaveformViewerProps["diagnostics"],
): AssertionBand[] {
  if (!design) return [];
  const bands: AssertionBand[] = [];
  const failedSubjects = new Map<string, string>();
  for (const d of diagnostics ?? []) {
    if (d.code !== "ASSERT_FAILED") continue;
    // related_elements = [test_id, subject]
    const related = d.related_elements ?? [];
    if (related.length >= 2) {
      failedSubjects.set(`${related[0]}::${related[1]}`, d.id ?? "");
    }
  }
  for (const test of design.tests.values()) {
    for (const a of test.assertions) {
      const op = a["op"];
      if (op !== "assert_voltage" && op !== "assert_current") continue;
      const subject =
        op === "assert_voltage"
          ? (a["net"] ?? "")
          : `i(${a["component"] ?? ""})`;
      if (!subject) continue;
      const key =
        op === "assert_voltage" ? `${test.id}_${subject}` : `${test.id}_${subject}`;
      const minRaw = a["min"];
      const maxRaw = a["max"];
      const unit = op === "assert_voltage" ? "V" : "A";
      const min = minRaw ? parseQty(minRaw, unit) : null;
      const max = maxRaw ? parseQty(maxRaw, unit) : null;
      const diagId = failedSubjects.get(`${test.id}::${subject}`) ?? "";
      bands.push({
        traceKey: key,
        min,
        max,
        diagnosticId: diagId,
        failed: diagId !== "",
      });
    }
  }
  return bands;
}

/** Null-tolerant parseQuantity wrapper (assertion min/max are optional). */
function parseQty(value: string, unit: string): number | null {
  try {
    return parseQuantity(value, unit);
  } catch {
    return null;
  }
}

/**
 * Small React hook — measures the container CSS width, tracks DPR, and returns
 * canvas backing-store dimensions so the canvas stays crisp on hi-DPI
 * without letterboxing.
 */
function useCanvasSize(container: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ cssWidth: 900, dpr: 1 });
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      setSize({ cssWidth: Math.max(320, Math.floor(rect.width)), dpr });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [container]);
  return size;
}

export function WaveformViewer({
  traces,
  design,
  diagnostics,
  perTraceHeight = 200,
  theme = "dark",
}: WaveformViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { cssWidth, dpr } = useCanvasSize(containerRef);
  const [hiddenTraces, setHiddenTraces] = useState<Set<string>>(new Set());
  const [manualY, setManualY] = useState<Map<string, [number, number]>>(new Map());
  const [xWindow, setXWindow] = useState<[number, number] | null>(null);
  const [cursors, setCursors] = useState<CursorState>({ a: null, b: null });
  const [dragging, setDragging] = useState<DragState | null>(null);
  const style = theme === "light" ? LIGHT_STYLE : DEFAULT_STYLE;

  // Build lanes (one per trace) with an LOD cache. `useMemo` on the trace
  // reference is enough: a new run produces new typed arrays.
  const lanes = useMemo<Lane[]>(() => {
    return traces.map((trace) => {
      const cache = new LodCache(trace.time, trace.values);
      const my = manualY.get(trace.key) ?? null;
      const [autoMin, autoMax] = paddedRange(cache.globalMin, cache.globalMax);
      return {
        key: trace.key,
        trace,
        cache,
        vMin: my ? my[0] : autoMin,
        vMax: my ? my[1] : autoMax,
        manualY: my,
        visible: !hiddenTraces.has(trace.key),
        color: colorForKey(trace.key),
      };
    });
  }, [traces, hiddenTraces, manualY]);

  // Global X range = union of all trace time ranges. This is the "zoom
  // out fully" state; `xWindow` overrides it once the user zooms in.
  const globalX = useMemo<[number, number]>(() => {
    if (lanes.length === 0) return [0, 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (const lane of lanes) {
      if (lane.cache.length === 0) continue;
      const t0 = lane.cache.time[0]!;
      const t1 = lane.cache.time[lane.cache.length - 1]!;
      if (t0 < lo) lo = t0;
      if (t1 > hi) hi = t1;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [0, 1];
    return [lo, hi];
  }, [lanes]);

  const activeX: [number, number] = xWindow ?? globalX;

  // Reset the X window whenever the trace set changes shape (a new run). We
  // use React's "keyed state" pattern (setting state during render when a
  // sentinel changes), which avoids the setState-in-effect anti-pattern.
  const [tracesToken, setTracesToken] = useState(traces);
  if (tracesToken !== traces) {
    setTracesToken(traces);
    setXWindow(null);
    setCursors({ a: null, b: null });
  }

  const visibleLanes = lanes.filter((l) => l.visible);
  const canvasCssHeight =
    LEGEND_HEIGHT + Math.max(1, visibleLanes.length) * perTraceHeight;

  const bands = useMemo(() => extractBands(design, diagnostics), [design, diagnostics]);

  // The RENDER pass. Runs whenever any input changes; `useCallback` so we
  // can also invoke it from event handlers during a drag without waiting
  // for React to re-render (mouse-move latency on a drag matters).
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const backingWidth = Math.floor(cssWidth * dpr);
    const backingHeight = Math.floor(canvasCssHeight * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${canvasCssHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Scale so 1 unit = 1 CSS pixel throughout the draw code — the LOD math
    // targets the plot's CSS width, so we would double-decimate if the ctx
    // ran in device-pixel space.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Clear.
    ctx.fillStyle = style.bg;
    ctx.fillRect(0, 0, cssWidth, canvasCssHeight);

    // One lane per visible trace, stacked top-to-bottom.
    visibleLanes.forEach((lane, index) => {
      const plot: Plot = {
        x0: LEFT_PAD,
        y0: LEGEND_HEIGHT + index * perTraceHeight + TOP_PAD,
        width: Math.max(1, cssWidth - LEFT_PAD - RIGHT_PAD),
        height: Math.max(1, perTraceHeight - TOP_PAD - BOTTOM_PAD),
        tMin: activeX[0],
        tMax: activeX[1],
        vMin: lane.vMin,
        vMax: lane.vMax,
      };
      drawBackground(ctx, plot, style);
      // Assertion bands for this lane (union of pass-band shading + failing-
      // column highlights).
      const laneBands = bands.filter((b) => b.traceKey === lane.key);
      for (const band of laneBands) {
        drawAssertionBand(ctx, plot, lane.cache, band.min, band.max, style);
      }
      drawAxes(ctx, plot, style, lane.trace.unit);
      drawTrace(ctx, plot, lane.cache, lane.color);
      // Cursors — the labels show the value AT the cursor time (snapped).
      if (cursors.a !== null) {
        const label = formatValueUnit(
          lane.cache.values[lane.cache.nearestSampleIndex(cursors.a)] ?? 0,
          lane.trace.unit,
        );
        drawCursor(ctx, plot, cursors.a, style, `A:${label}`);
      }
      if (cursors.b !== null) {
        const label = formatValueUnit(
          lane.cache.values[lane.cache.nearestSampleIndex(cursors.b)] ?? 0,
          lane.trace.unit,
        );
        drawCursor(ctx, plot, cursors.b, style, `B:${label}`);
      }
    });

    // Zoom-box rubber-band, if the user is drag-selecting.
    if (dragging?.kind === "box") {
      drawZoomBox(
        ctx,
        {
          x0: LEFT_PAD,
          y0: 0,
          width: cssWidth - LEFT_PAD - RIGHT_PAD,
          height: canvasCssHeight,
          tMin: 0,
          tMax: 1,
          vMin: 0,
          vMax: 1,
        },
        dragging.startX,
        dragging.startY,
        dragging.currentX,
        dragging.currentY,
        style,
      );
    }
  }, [
    cssWidth,
    dpr,
    canvasCssHeight,
    visibleLanes,
    activeX,
    style,
    perTraceHeight,
    cursors,
    bands,
    dragging,
  ]);

  useEffect(() => {
    draw();
  }, [draw]);

  // -------------------------------------------------------------- Input --

  const hitTestLane = (offsetY: number): number => {
    if (offsetY < LEGEND_HEIGHT) return -1;
    return Math.min(
      Math.max(0, Math.floor((offsetY - LEGEND_HEIGHT) / perTraceHeight)),
      visibleLanes.length - 1,
    );
  };

  const laneToPlot = (index: number): Plot => ({
    x0: LEFT_PAD,
    y0: LEGEND_HEIGHT + index * perTraceHeight + TOP_PAD,
    width: Math.max(1, cssWidth - LEFT_PAD - RIGHT_PAD),
    height: Math.max(1, perTraceHeight - TOP_PAD - BOTTOM_PAD),
    tMin: activeX[0],
    tMax: activeX[1],
    vMin: visibleLanes[index]?.vMin ?? 0,
    vMax: visibleLanes[index]?.vMax ?? 1,
  });

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (visibleLanes.length === 0) return;
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < LEFT_PAD || px > cssWidth - RIGHT_PAD) return;
    const zoom = e.deltaY < 0 ? 1 / 1.2 : 1.2;
    const [t0, t1] = activeX;
    const anchor = xToTime(
      { x0: LEFT_PAD, width: cssWidth - LEFT_PAD - RIGHT_PAD, tMin: t0, tMax: t1, y0: 0, height: 1, vMin: 0, vMax: 1 },
      px,
    );
    const nt0 = anchor - (anchor - t0) * zoom;
    const nt1 = anchor + (t1 - anchor) * zoom;
    const [g0, g1] = globalX;
    // Clamp to global — never zoom out past the raw range or invert it.
    const clamped: [number, number] = [Math.max(nt0, g0), Math.min(nt1, g1)];
    if (clamped[1] - clamped[0] < (g1 - g0) * 1e-9) return;
    setXWindow(clamped);
  };

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (visibleLanes.length === 0) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < LEFT_PAD || px > cssWidth - RIGHT_PAD) return;
    // Shift-drag OR right-drag = box zoom; plain drag = pan.
    const laneIndex = hitTestLane(py);
    const isBox = e.shiftKey || e.button === 2;
    setDragging({
      kind: isBox ? "box" : "pan",
      startX: px,
      startY: py,
      currentX: px,
      currentY: py,
      startTMin: activeX[0],
      startTMax: activeX[1],
      laneIndex,
    });
  };

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (dragging.kind === "pan") {
      const plotWidth = cssWidth - LEFT_PAD - RIGHT_PAD;
      const dPx = px - dragging.startX;
      const dt = (dPx / plotWidth) * (dragging.startTMax - dragging.startTMin);
      const [g0, g1] = globalX;
      let nt0 = dragging.startTMin - dt;
      let nt1 = dragging.startTMax - dt;
      if (nt0 < g0) {
        const shift = g0 - nt0;
        nt0 += shift;
        nt1 += shift;
      }
      if (nt1 > g1) {
        const shift = nt1 - g1;
        nt0 -= shift;
        nt1 -= shift;
      }
      setXWindow([nt0, nt1]);
    } else {
      setDragging({ ...dragging, currentX: px, currentY: py });
    }
  };

  const onMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragging) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (dragging.kind === "box") {
      const plotWidth = cssWidth - LEFT_PAD - RIGHT_PAD;
      if (Math.abs(px - dragging.startX) > 4) {
        const tStart = dragging.startTMin +
          ((Math.min(dragging.startX, px) - LEFT_PAD) / plotWidth) *
            (dragging.startTMax - dragging.startTMin);
        const tEnd = dragging.startTMin +
          ((Math.max(dragging.startX, px) - LEFT_PAD) / plotWidth) *
            (dragging.startTMax - dragging.startTMin);
        setXWindow([tStart, tEnd]);
      } else {
        // Small drag = click; place cursor A on left-click, B on shift+click
        placeCursor(px, e.shiftKey);
      }
    } else {
      // A pan that never moved is a click — set the cursor.
      if (Math.abs(px - dragging.startX) < 2) placeCursor(px, e.shiftKey);
    }
    setDragging(null);
  };

  const placeCursor = (px: number, secondary: boolean) => {
    const plotWidth = cssWidth - LEFT_PAD - RIGHT_PAD;
    const t = activeX[0] + ((px - LEFT_PAD) / plotWidth) * (activeX[1] - activeX[0]);
    // Snap to the nearest sample on the first (top) visible lane.
    const lane = visibleLanes[0];
    const snapped = lane ? lane.cache.time[lane.cache.nearestSampleIndex(t)] ?? t : t;
    setCursors((prev) => (secondary ? { ...prev, b: snapped } : { ...prev, a: snapped }));
  };

  const onDoubleClick = () => {
    setXWindow(null);
    setCursors({ a: null, b: null });
  };

  const onContextMenu = (e: React.MouseEvent) => e.preventDefault();

  // ------------------------------------------------------------- Legend --

  const toggleTrace = (key: string) => {
    setHiddenTraces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setLaneManualY = (key: string, range: [number, number] | null) => {
    setManualY((prev) => {
      const next = new Map(prev);
      if (range === null) next.delete(key);
      else next.set(key, range);
      return next;
    });
  };

  const exportCsv = (trace: WaveformTrace) => {
    const samples: [number, number][] = new Array(trace.values.length);
    for (let i = 0; i < trace.values.length; i++) {
      samples[i] = [trace.time[i]!, trace.values[i]!];
    }
    const csv = waveformCsv(trace.net, samples);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${trace.test}_${trace.net}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Cursor readout table (per-visible-lane value at A / value at B / Δv,
  // plus the shared Δt / 1/Δt at the top).
  const cursorReport = useMemo(() => {
    if (cursors.a === null && cursors.b === null) return null;
    const rows = visibleLanes.map((lane) => {
      const iA = cursors.a !== null ? lane.cache.nearestSampleIndex(cursors.a) : -1;
      const iB = cursors.b !== null ? lane.cache.nearestSampleIndex(cursors.b) : -1;
      const vA = iA >= 0 ? lane.cache.values[iA]! : null;
      const vB = iB >= 0 ? lane.cache.values[iB]! : null;
      const dv = vA !== null && vB !== null ? vB - vA : null;
      return {
        key: lane.key,
        label: lane.trace.label,
        unit: lane.trace.unit,
        vA,
        vB,
        dv,
      };
    });
    const dt = cursors.a !== null && cursors.b !== null ? cursors.b - cursors.a : null;
    const freq = dt !== null && dt !== 0 ? 1 / Math.abs(dt) : null;
    return { rows, dt, freq };
  }, [cursors, visibleLanes]);

  return (
    <div className="waveform-viewer" ref={containerRef} data-testid="waveform-viewer">
      <div className="waveform-viewer-legend">
        {lanes.map((lane) => (
          <label key={lane.key} className="waveform-viewer-trace-toggle" style={{ color: lane.color }}>
            <input
              type="checkbox"
              checked={lane.visible}
              onChange={() => toggleTrace(lane.key)}
              data-testid={`waveform-trace-toggle-${lane.key}`}
            />
            <span>{lane.trace.label}</span>
            <button
              type="button"
              onClick={() => exportCsv(lane.trace)}
              data-testid={`waveform-export-${lane.key}`}
              title="Export this trace as CSV"
            >
              CSV
            </button>
            <button
              type="button"
              onClick={() =>
                setLaneManualY(
                  lane.key,
                  lane.manualY ? null : [lane.vMin, lane.vMax],
                )
              }
              data-testid={`waveform-yauto-${lane.key}`}
              title="Toggle manual Y range"
            >
              {lane.manualY ? "Manual Y" : "Auto Y"}
            </button>
          </label>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="waveform-viewer-canvas"
        data-testid="waveform-canvas"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      <div className="waveform-viewer-annotations" aria-hidden>
        {/* Screen-reader-invisible anchors for assertion bands — each carries
            a link back to its diagnostic id for the audit-amendment requirement. */}
        {bands
          .filter((b) => visibleLanes.some((l) => l.key === b.traceKey))
          .map((band, index) => {
            const lane = visibleLanes.find((l) => l.key === band.traceKey)!;
            const laneIndex = visibleLanes.indexOf(lane);
            const plot = laneToPlot(laneIndex);
            const xLeft = timeToX(plot, activeX[0]);
            const xRight = timeToX(plot, activeX[1]);
            return (
              <div
                key={`${band.traceKey}-${index}`}
                data-testid={`waveform-assertion-${band.traceKey}${band.failed ? "-failed" : ""}`}
                aria-label={
                  band.failed
                    ? `Assertion ${band.diagnosticId || "failed"} on ${band.traceKey}`
                    : `Assertion band on ${band.traceKey}`
                }
                data-diagnostic-id={band.diagnosticId}
                style={{
                  position: "absolute",
                  left: xLeft,
                  top: plot.y0,
                  width: xRight - xLeft,
                  height: plot.height,
                  pointerEvents: "none",
                }}
              />
            );
          })}
      </div>
      {cursorReport && (
        <div className="waveform-viewer-cursor-report" data-testid="waveform-cursor-report">
          <div className="waveform-viewer-cursor-summary">
            {cursors.a !== null && (
              <span>A: {formatTime(cursors.a)}</span>
            )}
            {cursors.b !== null && (
              <span>B: {formatTime(cursors.b)}</span>
            )}
            {cursorReport.dt !== null && (
              <>
                <span data-testid="waveform-cursor-dt">Δt: {formatTime(Math.abs(cursorReport.dt))}</span>
                {cursorReport.freq !== null && (
                  <span data-testid="waveform-cursor-freq">1/Δt: {formatValueUnit(cursorReport.freq, "Hz")}</span>
                )}
              </>
            )}
          </div>
          <table className="waveform-viewer-cursor-table">
            <thead>
              <tr>
                <th>Trace</th>
                <th>A</th>
                <th>B</th>
                <th>Δv</th>
              </tr>
            </thead>
            <tbody>
              {cursorReport.rows.map((row) => (
                <tr key={row.key} data-testid={`waveform-cursor-row-${row.key}`}>
                  <td>{row.label}</td>
                  <td>{row.vA !== null ? formatValueUnit(row.vA, row.unit) : "-"}</td>
                  <td>{row.vB !== null ? formatValueUnit(row.vB, row.unit) : "-"}</td>
                  <td>{row.dv !== null ? formatValueUnit(row.dv, row.unit) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Give the visible Y range a small pad around the data extrema. */
function paddedRange(lo: number, hi: number): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi === lo) {
    if (lo === hi && Number.isFinite(lo)) return [lo - 1, lo + 1];
    return [0, 1];
  }
  const span = hi - lo;
  const pad = span * 0.08;
  return [lo - pad, hi + pad];
}
