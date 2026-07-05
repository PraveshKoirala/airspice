/**
 * Types for the compiled registry (port of the shapes registry.py loads).
 *
 * These mirror the JSON in registry/components/*.json and registry/mcu/*.json
 * plus the Python built-in fallbacks. Fields the validator never reads (renode /
 * platformio / cpu / memory metadata) are kept as an open index signature so the
 * generated data type-checks without enumerating every non-validation field.
 */

/** A component spec entry (registry/components/*.json, minus the `type` key). */
export interface ComponentSpec {
  required_pins?: string[];
  value_required?: boolean;
  required_properties?: string[];
  required_any?: string[];
  spice_supported?: boolean;
  // Non-validation metadata may exist on some entries; ignore unknown keys.
  [key: string]: unknown;
}

/** A single peripheral descriptor (ADC/I2C/UART). Only ADC `vref` is read. */
export interface PeripheralSpec {
  vref?: string | number;
  resolution_bits?: number;
  supported?: boolean;
  [key: string]: unknown;
}

/** An MCU spec entry (registry/mcu/*.json or a Python built-in). */
export interface McuSpec {
  part?: string;
  /** {pinName: "power" | "ground"} -- iterated by KEY in _validate_mcu. */
  power_pins: Record<string, string>;
  /** {pinName: [supported functions]} -- arrays (sorted() applied at emit). */
  pins: Record<string, string[]>;
  peripherals: Record<string, PeripheralSpec>;
  [key: string]: unknown;
}
