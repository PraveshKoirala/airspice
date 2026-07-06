/**
 * Port of `packages/core/src/air/model.py`.
 *
 * These interfaces mirror the frozen dataclasses field-for-field. The field
 * NAMES are load-bearing: `serializeModel` emits them straight into
 * `model.json`, which is byte-diffed against the oracle. Optional Python fields
 * that default to `None` are modeled as `T | null` (never `undefined`), because
 * the oracle serializes them as JSON `null`; keeping them present-and-null makes
 * the dump logic a direct mirror of `model_dump.py`.
 *
 * DICT-MIRRORING COLLECTIONS ARE Map, NOT Record (issue #8 rework round 1).
 * Python dicts iterate in insertion (document) order for EVERY key; plain JS
 * objects iterate integer-like keys ("1", "2", "10") in ascending numeric order
 * first, regardless of insertion. That divergence is invisible to model.json
 * (its serializer sorts keys) but observable anywhere document-order iteration
 * matters -- validation's diagnostic emission order, `pins[0]` positional
 * access in the load budget, and float accumulation order. Since integer-like
 * ids/pin names ("1"/"2" pins are the NORM for passives) are valid AIR, every
 * keyed collection that mirrors a Python dict is a Map, whose iteration order
 * is insertion order for all key types. `Map.set` also matches Python dict
 * assignment on duplicate keys (last value wins, first insertion position kept).
 *
 * `data` bags on Interface/Bridge hold heterogeneous XML-derived structures
 * (attribute maps, or arrays of them for repeated child tags); see parser.ts.
 * They REMAIN plain Records deliberately: no code path iterates them where
 * order is observable (validation reads fixed keys; serialization sorts keys),
 * and their values are consumed via `asList` / direct key access.
 */

export interface Metadata {
  title: string;
  description: string;
  author: string;
  created_at: string;
}

export interface Net {
  id: string;
  role: string;
  nominal_voltage: string | null;
}

export interface PowerDomain {
  id: string;
  net: string;
  nominal: string | null;
  source: string | null;
}

export interface PinConnection {
  name: string;
  net: string;
  function: string | null;
}

export interface Component {
  id: string;
  type: string;
  part: string | null;
  spice_model: string | null;
  spice_subckt: string | null;
  value: string | null;
  pins: Map<string, PinConnection>;
  properties: Map<string, string>;
}

/** A child-tag attribute map, or a repeated tag's attribute maps as an array. */
export type InterfaceDatum = Record<string, string> | Array<Record<string, string>>;

export interface Interface {
  id: string;
  type: string;
  data: Record<string, InterfaceDatum>;
}

export interface Probe {
  id: string;
  net: string;
  quantity: string;
}

export interface AnalogSubsystem {
  id: string;
  uses: string[];
  probes: Probe[];
}

export interface FirmwareProject {
  id: string;
  target: string;
  framework: string;
  language: string;
  board: string;
  source_tree: string;
}

export interface FirmwareBinding {
  id: string;
  signal: string;
  component: string;
  peripheral: string;
  channel: string;
  net: string;
}

/**
 * A firmware task operation. Always carries `op` (the source child tag); the
 * remaining keys are that element's attributes, plus an optional `text` when
 * the element had non-empty stripped text content.
 */
export type FirmwareOperation = Record<string, string>;

export interface FirmwareTask {
  id: string;
  target: string;
  period: string;
  operations: FirmwareOperation[];
}

/** Bridge `data`: flat attribute strings mixed with nested child-tag maps. */
export type BridgeDatum = string | Record<string, string>;

export interface Bridge {
  id: string;
  type: string;
  data: Record<string, BridgeDatum>;
}

/**
 * AC small-signal sweep description for a test (issue #62).
 *
 * Mirror of the Python ``Analysis`` dataclass. ``type`` today is always ``"ac"``;
 * the field exists so future analyses (``dc``, ``noise``, ...) slot in without
 * another Test attribute. When ``type == "ac"`` the four string fields
 * (``sweep``, ``points``, ``start``, ``end``) are the ngspice ``.ac`` card's
 * arguments verbatim (§15.3.1 ngspice-46 manual): ``sweep`` is ``dec`` / ``oct``
 * / ``lin``; ``points`` is points-per-decade/octave (or total, for ``lin``);
 * ``start`` / ``end`` are frequency strings the units module parses to Hz.
 * Absent (``null``) on a Test -> the emitter takes the historical ``.tran`` path
 * (backward compatible; the existing corpus is unchanged).
 */
export interface Analysis {
  type: string;
  sweep: string;
  points: string;
  start: string;
  end: string;
}

export interface Test {
  id: string;
  description: string;
  setup: Map<string, string>;
  duration: string;
  assertions: Array<Record<string, string>>;
  /** Optional analysis descriptor (AC today). null == the .tran path. */
  analysis: Analysis | null;
}

export interface SimulationProfile {
  id: string;
  default: boolean;
  backends: string[];
  included_subsystems: string[];
  tests: string[];
  properties: Map<string, string>;
}

export interface ExportTarget {
  target: string;
  enabled: boolean;
}

export interface SystemIR {
  name: string;
  ir_version: string;
  metadata: Metadata;
  requirements: Array<Record<string, string>>;
  nets: Map<string, Net>;
  power_domains: Map<string, PowerDomain>;
  components: Map<string, Component>;
  interfaces: Map<string, Interface>;
  analog: AnalogSubsystem[];
  firmware_projects: Map<string, FirmwareProject>;
  firmware_bindings: Map<string, FirmwareBinding>;
  firmware_tasks: Map<string, FirmwareTask>;
  bridges: Bridge[];
  tests: Map<string, Test>;
  simulation_profiles: Map<string, SimulationProfile>;
  exports: ExportTarget[];
}
