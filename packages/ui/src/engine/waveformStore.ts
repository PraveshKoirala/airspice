/**
 * Waveform retention store (issue #14 deliverable 3).
 *
 * Keeps simulation waveforms as TYPED ARRAYS (`Float64Array`), keyed by run id —
 * NOT converted to `number[]` / JSON anywhere in the hot path (AGENTS.md /
 * epic #12 guardrail: typed arrays end to end). The engine transfers each
 * probe's samples across the worker boundary as a `Float64Array`; they land here
 * untouched and are handed to the chart / CSV export as-is.
 *
 * A deliberately tiny module-level store rather than a new state-management
 * dependency: the issue's load-bearing requirement is "typed arrays (not JSON)
 * retained, keyed by run id", which a `Map<runId, RunWaveforms>` delivers with
 * ZERO bundle-size impact. Adding zustand would be a heavier dep for a subscribe
 * surface the Simulation tab does not need (it reads the store synchronously
 * after a run completes). If a future issue needs reactive subscriptions across
 * many components, promote this to zustand then (with the stated bundle impact).
 */

/** One probed signal's retained samples: a name + typed time/value arrays. */
export interface RetainedWaveform {
  /** The probed net (unprefixed, e.g. "mid", "battery_sense"). */
  net: string;
  /** The test this waveform belongs to. */
  test: string;
  /** Time axis (seconds), a transferred Float64Array — never JSON-ified. */
  time: Float64Array;
  /** Signal values (volts), a transferred Float64Array — never JSON-ified. */
  values: Float64Array;
}

/** All waveforms retained for a single run, indexed by `${test}_${net}`. */
export interface RunWaveforms {
  runId: string;
  waveforms: Map<string, RetainedWaveform>;
}

const store = new Map<string, RunWaveforms>();

/** Cap on retained runs so a long session cannot grow the store unbounded. */
const MAX_RETAINED_RUNS = 8;

/** Retain a run's waveforms (typed arrays), evicting the oldest over the cap. */
export function retainRun(run: RunWaveforms): void {
  store.set(run.runId, run);
  while (store.size > MAX_RETAINED_RUNS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** The waveforms retained for a run id, or undefined if evicted/never run. */
export function getRun(runId: string): RunWaveforms | undefined {
  return store.get(runId);
}

/** One retained waveform by run id + `${test}_${net}` key. */
export function getWaveform(runId: string, test: string, net: string): RetainedWaveform | undefined {
  return store.get(runId)?.waveforms.get(`${test}_${net}`);
}

/** Drop a run's retained waveforms (e.g. on a re-run of the same design). */
export function clearRun(runId: string): void {
  store.delete(runId);
}

/** Clear the entire store (test hook / dispose). */
export function clearAll(): void {
  store.clear();
}
