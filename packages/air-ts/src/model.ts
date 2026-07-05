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
 * `data` bags on Interface/Bridge hold heterogeneous XML-derived structures
 * (attribute maps, or arrays of them for repeated child tags); see parser.ts.
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
  pins: Record<string, PinConnection>;
  properties: Record<string, string>;
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

export interface Test {
  id: string;
  description: string;
  setup: Record<string, string>;
  duration: string;
  assertions: Array<Record<string, string>>;
}

export interface SimulationProfile {
  id: string;
  default: boolean;
  backends: string[];
  included_subsystems: string[];
  tests: string[];
  properties: Record<string, string>;
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
  nets: Record<string, Net>;
  power_domains: Record<string, PowerDomain>;
  components: Record<string, Component>;
  interfaces: Record<string, Interface>;
  analog: AnalogSubsystem[];
  firmware_projects: Record<string, FirmwareProject>;
  firmware_bindings: Record<string, FirmwareBinding>;
  firmware_tasks: Record<string, FirmwareTask>;
  bridges: Bridge[];
  tests: Record<string, Test>;
  simulation_profiles: Record<string, SimulationProfile>;
  exports: ExportTarget[];
}
