/**
 * Convert eecircuit-engine's `ResultType` into our transferable `WaveTable[]`.
 *
 * eecircuit types NEVER leak past this module (issue guardrail: "no eecircuit
 * types may leak into packages/ui"). The engine adapter (`engine.worker.ts`)
 * calls into here; everything downstream sees only our `WaveTable`.
 *
 * eecircuit's real-analysis result shape (from its main.d.ts) is:
 *   { header, numVariables, variableNames, numPoints, dataType: "real",
 *     data: { name, type, values: number[] }[] }
 * We map `type` -> our SignalUnit and `values` -> Float64Array.
 */

import type { ProbeSpec, SignalUnit, WaveTable } from "./protocol.js";

/** Minimal structural view of eecircuit's result -- NOT an import of its types. */
interface RawVector {
  name: string;
  type: string;
  values: unknown; // number[] for real analyses
}
interface RawResult {
  dataType?: string;
  variableNames?: string[];
  data?: RawVector[];
}

const UNIT_MAP: Record<string, SignalUnit> = {
  time: "time",
  voltage: "voltage",
  current: "current",
  frequency: "frequency",
  notype: "notype",
};

function toUnit(type: string | undefined): SignalUnit {
  return (type && UNIT_MAP[type]) || "notype";
}

/**
 * Build WaveTable[] from a raw eecircuit result, optionally filtered/ordered by
 * `probes`. Complex (AC) results are flattened to their real part for now (the
 * corpus is transient/DC; AC is out of scope for #13).
 *
 * @returns the tables plus the Float64Array buffers to transfer.
 */
export function toWaveTables(
  raw: RawResult,
  probes?: ProbeSpec[],
): { tables: WaveTable[]; transfer: ArrayBufferLike[] } {
  const vectors = Array.isArray(raw.data) ? raw.data : [];
  const byName = new Map<string, RawVector>();
  for (const v of vectors) byName.set(v.name.toLowerCase(), v);

  const wanted: RawVector[] = [];
  const named = (probes ?? []).filter((p) => p.vector);
  if (named.length > 0) {
    for (const p of named) {
      const v = byName.get((p.vector as string).toLowerCase());
      if (v) wanted.push(v);
    }
  } else {
    wanted.push(...vectors);
  }

  const tables: WaveTable[] = [];
  const transfer: ArrayBufferLike[] = [];
  for (const v of wanted) {
    const values = toFloat64(v.values);
    tables.push({ name: v.name, unit: toUnit(v.type), values });
    transfer.push(values.buffer);
  }
  return { tables, transfer };
}

/** Coerce an eecircuit values array (number[] or {real,img}[]) to Float64Array. */
function toFloat64(values: unknown): Float64Array {
  if (values instanceof Float64Array) return values;
  if (!Array.isArray(values)) return new Float64Array(0);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const x = values[i] as number | { real: number };
    out[i] = typeof x === "number" ? x : (x && typeof x.real === "number" ? x.real : NaN);
  }
  return out;
}

/**
 * The final (last) sample of a named vector, case-insensitively. Used by tests
 * to assert final node voltages against the corpus report. Returns NaN if the
 * vector is absent or empty.
 */
export function finalValue(tables: readonly WaveTable[], name: string): number {
  const t = tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t || t.values.length === 0) return NaN;
  return t.values[t.values.length - 1] ?? NaN;
}
