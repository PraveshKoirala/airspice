/**
 * Deterministic color assignment for waveform traces (issue #25 deliverable 3).
 *
 * We use a fixed palette (curated for contrast on both light and dark themes)
 * indexed by a stable hash of the trace's `test_net` key. Deterministic
 * matters: a re-run of the same design MUST produce the same trace colors so
 * the human is not chasing "what changed" through a color permutation.
 *
 * No CSS variables here on purpose — the canvas 2D API takes colors as
 * strings, and `getComputedStyle` per frame would be a hidden main-thread
 * cost. The palette is picked to be legible against both `--panel-bg` values
 * in App.css.
 */

/** 10-slot palette (Okabe-Ito + a few extras); high-contrast, color-blind safe. */
const PALETTE: readonly string[] = [
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#009E73", // green
  "#CC79A7", // purple
  "#E69F00", // orange
  "#56B4E9", // sky
  "#F0E442", // yellow
  "#B22222", // dark red
  "#8E44AD", // violet
  "#16A085", // teal
];

/** FNV-1a 32-bit hash — stable across runs, no seed needed. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit multiplication carried out in the 53-bit safe range.
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** Assign a deterministic color to a trace key. */
export function colorForKey(key: string): string {
  const h = fnv1a32(key);
  return PALETTE[h % PALETTE.length]!;
}

/** Palette length (for pickers / UI hints). */
export const PALETTE_SIZE = PALETTE.length;
