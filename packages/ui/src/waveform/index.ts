/**
 * Public exports for the waveform viewer (issue #25).
 *
 * The viewer sits behind ONE component (`WaveformViewer`) plus a few pure
 * helpers the panel + tests reuse. Everything else in this folder is an
 * implementation detail.
 */

export { WaveformViewer } from "./WaveformViewer";
export type { WaveformTrace, AssertionBand, WaveformViewerProps } from "./WaveformViewer";
export { LodCache } from "./decimation";
export type { Bucket } from "./decimation";
export {
  DEFAULT_STYLE,
  drawAssertionBand,
  drawAxes,
  drawBackground,
  drawCursor,
  drawTrace,
  drawZoomBox,
  timeToX,
  valueToY,
  xToTime,
  yToValue,
} from "./render";
export type { Plot, Style, Ctx } from "./render";
export { formatTick, formatTime, formatValueUnit, niceTickStep, tickPositions } from "./units";
export { colorForKey, PALETTE_SIZE } from "./palette";
