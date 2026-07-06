/**
 * Min/max per-pixel-column decimation with a Level-of-Detail (LOD) cache
 * (issue #25 deliverable 2). This is the load-bearing algorithm for the
 * scope-grade waveform viewer: a stride-subsampled implementation would look
 * done and be WRONG — it hides one-sample glitches, which is exactly what a
 * SPICE user is scoping for (see the spike-preservation test in
 * `tests/browser/waveform-viewer.spec.ts`).
 *
 * The algorithm:
 *
 * 1. For a target column count `cols` and a sample range `[i0, i1)`, we split
 *    the range into `cols` buckets and record `(min, max, tMin, tMax)` for each.
 *    Rendering draws a vertical bar from `min` to `max` in every column, so any
 *    spike inside a bucket appears as an extended vertical segment — the spike
 *    survives even when 1000 samples collapse into one pixel.
 *
 * 2. To make interactive zoom/pan cheap, we build a MIP-map-style LOD pyramid:
 *    LOD 0 is the raw samples, LOD 1 is min/max pairs over blocks of 2 samples,
 *    LOD k is min/max pairs over blocks of `2^k`. A visible range of N samples
 *    picks the coarsest LOD with ~2 blocks per column, then decimates that LOD
 *    into `cols` output buckets. Total build cost is O(N); each frame is
 *    O(cols) after the pyramid is built.
 *
 * Both the pyramid and the per-frame decimation operate on `Float64Array`s
 * end-to-end (never `number[]`), matching the typed-array discipline retained
 * from #14.
 */

/**
 * One decimated pixel column. `tMin`/`tMax` are the sample TIMES at which the
 * min and max occurred inside the bucket, so cursors can snap to the actual
 * sample rather than the bucket midpoint.
 */
export interface Bucket {
  min: number;
  max: number;
  tMin: number;
  tMax: number;
  /** Sample index of the min inside the raw arrays (for snap-to-sample). */
  iMin: number;
  /** Sample index of the max inside the raw arrays (for snap-to-sample). */
  iMax: number;
}

/**
 * A LOD pyramid level: min/max pairs over blocks of `blockSize` raw samples.
 * Level 0 is a virtual pass-through (the raw arrays); this array only holds
 * levels 1..K, so `levels[0]` is the level with `blockSize=2`.
 */
interface LodLevel {
  /** Number of raw samples aggregated per block (>= 2). */
  blockSize: number;
  /** `mins[b]` = min of raw values in block b. */
  mins: Float64Array;
  /** `maxs[b]` = max of raw values in block b. */
  maxs: Float64Array;
  /** Raw-sample index at which `mins[b]` occurred (for snap-to-sample). */
  iMins: Int32Array;
  /** Raw-sample index at which `maxs[b]` occurred (for snap-to-sample). */
  iMaxs: Int32Array;
}

/**
 * A per-trace LOD cache. Immutable once built for a given `(time, values)`
 * pair; the WaveformViewer keeps one per visible trace and rebuilds on the
 * (rare) event that the underlying arrays change.
 */
export class LodCache {
  readonly time: Float64Array;
  readonly values: Float64Array;
  readonly length: number;
  private levels: LodLevel[] = [];
  /** Cached whole-range extrema (unit-agnostic; the viewer scales per-trace). */
  readonly globalMin: number;
  readonly globalMax: number;
  readonly globalTMin: number;
  readonly globalTMax: number;

  constructor(time: Float64Array, values: Float64Array) {
    if (time.length !== values.length) {
      throw new Error(
        `LodCache: time (${time.length}) and values (${values.length}) length mismatch`,
      );
    }
    this.time = time;
    this.values = values;
    this.length = values.length;

    // Scan raw for the global extrema (used for the initial Y-auto-scale).
    let gmin = Infinity;
    let gmax = -Infinity;
    let itMin = 0;
    let itMax = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (v < gmin) {
        gmin = v;
        itMin = i;
      }
      if (v > gmax) {
        gmax = v;
        itMax = i;
      }
    }
    if (!Number.isFinite(gmin)) {
      gmin = 0;
      gmax = 0;
    }
    this.globalMin = gmin;
    this.globalMax = gmax;
    this.globalTMin = values.length ? time[itMin]! : 0;
    this.globalTMax = values.length ? time[itMax]! : 0;

    this.buildLevels();
  }

  /**
   * Build the LOD pyramid. Level k aggregates two entries from level k-1 (or
   * two raw samples for k=1), so the total memory is < 2x the raw values
   * (geometric series 1 + 1/2 + 1/4 + ...). The last level has at least 4
   * blocks so `pickLevel` always has room to pick 2 blocks per column at the
   * whole-range zoom.
   */
  private buildLevels(): void {
    if (this.length < 4) return;

    // Level 1: min/max over blocks of 2 raw samples.
    let level = buildLevelFromRaw(this.values, 2);
    this.levels.push(level);
    // Levels 2..K: min/max over blocks of the previous level's pairs. Stop
    // when the next level would have fewer than 4 blocks (small enough that
    // decimating from the previous level is already O(cols) cheap).
    while (level.mins.length >= 8) {
      const next = buildLevelFromLevel(level);
      this.levels.push(next);
      level = next;
    }
  }

  /**
   * Pick the LOD level whose block size gives ~2 blocks per output column for
   * a visible range of `rangeSamples` samples and `cols` output columns. The
   * "2 blocks per column" target is the sweet spot: fewer blocks per column
   * risks aliasing a min/max between two adjacent buckets; more wastes work.
   *
   * Returns -1 for "use the raw arrays" (level 0). Never returns a level with
   * `blockSize > rangeSamples / cols` unless there is no cheaper option, so the
   * fully-zoomed-out 1M-point / 800-column case picks the ~1024-block-size
   * level and decimates ~2M pairs into 800 columns.
   */
  pickLevel(rangeSamples: number, cols: number): number {
    if (this.levels.length === 0) return -1;
    const target = Math.max(2, rangeSamples / cols / 2);
    let best = -1;
    let bestBlock = 1;
    for (let k = 0; k < this.levels.length; k++) {
      const bs = this.levels[k]!.blockSize;
      if (bs <= target && bs > bestBlock) {
        best = k;
        bestBlock = bs;
      }
    }
    return best;
  }

  /**
   * Decimate the visible range `[t0, t1]` into `cols` per-column buckets.
   *
   * The buckets are laid out UNIFORMLY in TIME (not in sample index): the
   * viewer's X mapping is time-based, so a bucket at column `c` covers
   * `t0 + c*dt` to `t0 + (c+1)*dt`. That matches the render mapping exactly, so
   * a spike at time `ts` lands in column `floor((ts - t0) / dt * cols)`.
   *
   * `out` is optional and MAY be pre-allocated across frames to avoid GC.
   */
  decimate(t0: number, t1: number, cols: number, out?: Bucket[]): Bucket[] {
    if (cols <= 0) return out ?? [];
    const buckets: Bucket[] = out ?? new Array<Bucket>(cols);
    if (buckets.length !== cols) buckets.length = cols;

    // Locate the sample-index window [i0, i1) covering [t0, t1]. The time
    // array is monotonically non-decreasing (transient sweep vector), so
    // binary search is well-defined.
    const i0 = lowerBound(this.time, t0);
    const i1 = upperBound(this.time, t1);
    if (i1 <= i0) {
      for (let c = 0; c < cols; c++) buckets[c] = emptyBucket();
      return buckets;
    }
    const rangeSamples = i1 - i0;
    const level = this.pickLevel(rangeSamples, cols);
    const dt = (t1 - t0) / cols || 1;

    // Prime every bucket to the sentinel; each fill will overwrite.
    for (let c = 0; c < cols; c++) buckets[c] = emptyBucket();

    if (level < 0) {
      // Decimate raw samples directly (interactive zoom-in).
      for (let i = i0; i < i1; i++) {
        const t = this.time[i]!;
        const v = this.values[i]!;
        let col = Math.floor((t - t0) / dt);
        if (col < 0) col = 0;
        else if (col >= cols) col = cols - 1;
        fillBucket(buckets[col]!, v, t, i);
      }
    } else {
      const lvl = this.levels[level]!;
      // Block index range in this LOD level.
      const b0 = Math.floor(i0 / lvl.blockSize);
      const b1 = Math.min(lvl.mins.length, Math.ceil(i1 / lvl.blockSize));
      for (let b = b0; b < b1; b++) {
        const vmin = lvl.mins[b]!;
        const vmax = lvl.maxs[b]!;
        const imn = lvl.iMins[b]!;
        const imx = lvl.iMaxs[b]!;
        const tmn = this.time[imn]!;
        const tmx = this.time[imx]!;
        // The min and the max of a block can fall in DIFFERENT columns (a
        // spike near the block edge), so we place them independently.
        let colMin = Math.floor((tmn - t0) / dt);
        if (colMin < 0) colMin = 0;
        else if (colMin >= cols) colMin = cols - 1;
        fillBucket(buckets[colMin]!, vmin, tmn, imn);

        let colMax = Math.floor((tmx - t0) / dt);
        if (colMax < 0) colMax = 0;
        else if (colMax >= cols) colMax = cols - 1;
        fillBucket(buckets[colMax]!, vmax, tmx, imx);
      }
    }

    return buckets;
  }

  /**
   * Find the sample index nearest to time `t` inside the raw arrays. Used by
   * the cursor's snap-to-sample so the reported value is exactly the value at
   * a real sample, never an interpolated bucket boundary.
   */
  nearestSampleIndex(t: number): number {
    if (this.length === 0) return -1;
    const upper = upperBound(this.time, t);
    if (upper === 0) return 0;
    if (upper >= this.length) return this.length - 1;
    const left = upper - 1;
    const right = upper;
    const dl = Math.abs(this.time[left]! - t);
    const dr = Math.abs(this.time[right]! - t);
    return dl <= dr ? left : right;
  }
}

/** Aggregate raw samples into blocks of `blockSize` (`blockSize >= 2`). */
function buildLevelFromRaw(values: Float64Array, blockSize: number): LodLevel {
  const blocks = Math.floor(values.length / blockSize);
  const mins = new Float64Array(blocks);
  const maxs = new Float64Array(blocks);
  const iMins = new Int32Array(blocks);
  const iMaxs = new Int32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const start = b * blockSize;
    const end = start + blockSize;
    let mn = values[start]!;
    let mx = mn;
    let imn = start;
    let imx = start;
    for (let i = start + 1; i < end; i++) {
      const v = values[i]!;
      if (v < mn) {
        mn = v;
        imn = i;
      }
      if (v > mx) {
        mx = v;
        imx = i;
      }
    }
    mins[b] = mn;
    maxs[b] = mx;
    iMins[b] = imn;
    iMaxs[b] = imx;
  }
  return { blockSize, mins, maxs, iMins, iMaxs };
}

/**
 * Build the next coarser level by pairwise-combining the previous level. The
 * min-of-a-block is the smaller of the two children's mins; the sample-index
 * carries over so `iMins`/`iMaxs` still point at raw samples (that is what
 * lets a spike stay pinpointable through many LOD passes).
 */
function buildLevelFromLevel(prev: LodLevel): LodLevel {
  const nBlocks = Math.floor(prev.mins.length / 2);
  const mins = new Float64Array(nBlocks);
  const maxs = new Float64Array(nBlocks);
  const iMins = new Int32Array(nBlocks);
  const iMaxs = new Int32Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    const a = b * 2;
    const c = a + 1;
    if (prev.mins[a]! <= prev.mins[c]!) {
      mins[b] = prev.mins[a]!;
      iMins[b] = prev.iMins[a]!;
    } else {
      mins[b] = prev.mins[c]!;
      iMins[b] = prev.iMins[c]!;
    }
    if (prev.maxs[a]! >= prev.maxs[c]!) {
      maxs[b] = prev.maxs[a]!;
      iMaxs[b] = prev.iMaxs[a]!;
    } else {
      maxs[b] = prev.maxs[c]!;
      iMaxs[b] = prev.iMaxs[c]!;
    }
  }
  return { blockSize: prev.blockSize * 2, mins, maxs, iMins, iMaxs };
}

/** A sentinel "no samples this column" bucket. `min > max` marks it empty. */
function emptyBucket(): Bucket {
  return {
    min: Infinity,
    max: -Infinity,
    tMin: NaN,
    tMax: NaN,
    iMin: -1,
    iMax: -1,
  };
}

function fillBucket(b: Bucket, v: number, t: number, i: number): void {
  if (v < b.min) {
    b.min = v;
    b.tMin = t;
    b.iMin = i;
  }
  if (v > b.max) {
    b.max = v;
    b.tMax = t;
    b.iMax = i;
  }
}

/** True if the bucket saw no samples this column. */
export function isEmpty(b: Bucket): boolean {
  return b.min > b.max;
}

/** First index in `arr` with `arr[i] >= x` (standard lower_bound). */
function lowerBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in `arr` with `arr[i] > x` (standard upper_bound). */
function upperBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
