/**
 * Hand-ported Python built-in fallbacks from `registry.py` (_BUILTIN_MCUS,
 * _BUILTIN_COMPONENTS, PASSIVE_TYPES, SUPPORTED_SPICE_TYPES).
 *
 * PARITY: these are the exact fallbacks the oracle seeds before layering the
 * on-disk registry files over them (`MCUS = dict(_BUILTIN_MCUS)` then per-part
 * override; likewise COMPONENT_SPECS). registry.ts merges the generated file
 * data OVER these, reproducing that runtime semantics: a registry file wins on
 * collision (ESP32-C3 / ESP32-WROOM-32 exist in both, file version used), and a
 * builtin still answers if its file is ever removed (Python's dir-absent path).
 *
 * The MCU `pins` are stored as arrays here (Python uses sets); the validator
 * applies `sorted()` where the oracle does, so array-vs-set is not observable.
 */

import type { ComponentSpec, McuSpec } from "./types.js";

/** Port of registry._BUILTIN_MCUS. */
export const BUILTIN_MCUS: Record<string, McuSpec> = {
  "ESP32-C3": {
    power_pins: { "3V3": "power", GND: "ground" },
    pins: {
      GPIO0: ["GPIO", "ADC1_CH0", "GPIO_OUT"],
      GPIO1: ["GPIO", "ADC1_CH1", "GPIO_OUT"],
      GPIO2: ["GPIO", "ADC1_CH2", "GPIO_OUT"],
      GPIO3: ["GPIO", "ADC1_CH3", "GPIO_OUT"],
      GPIO4: ["GPIO", "ADC1_CH4", "GPIO_OUT"],
      GPIO5: ["GPIO", "ADC1_CH5", "GPIO_OUT"],
      GPIO8: ["GPIO", "I2C_SDA", "GPIO_OUT"],
      GPIO9: ["GPIO", "I2C_SCL", "GPIO_OUT"],
      TX: ["UART_TX"],
      RX: ["UART_RX"],
    },
    peripherals: {
      ADC1: { resolution_bits: 12, vref: "3.3V" },
      I2C0: { supported: true },
      UART0: { supported: true },
    },
  },
  "ESP32-WROOM-32": {
    power_pins: { "3V3": "power", GND: "ground" },
    pins: {
      GPIO32: ["GPIO", "ADC1_CH4"],
      GPIO33: ["GPIO", "ADC1_CH5"],
      GPIO21: ["GPIO", "I2C_SDA"],
      GPIO22: ["GPIO", "I2C_SCL"],
      TX: ["UART_TX"],
      RX: ["UART_RX"],
    },
    peripherals: {
      ADC1: { resolution_bits: 12, vref: "3.3V" },
      I2C0: { supported: true },
      UART0: { supported: true },
    },
  },
};

/** Port of registry._BUILTIN_COMPONENTS. */
export const BUILTIN_COMPONENTS: Record<string, ComponentSpec> = {
  resistor: { required_pins: ["1", "2"], value_required: true, spice_supported: true },
  capacitor: { required_pins: ["1", "2"], value_required: true, spice_supported: true },
  voltage_source: { required_pins: ["p", "n"], value_required: true, spice_supported: true },
  current_source: { required_pins: ["p", "n"], value_required: true, spice_supported: true },
  generic_load: { required_pins: ["p", "n"], required_any: ["value", "current"], spice_supported: true },
  ldo: {
    required_pins: ["in", "out", "gnd"],
    required_properties: ["vout", "iout_max", "v_dropout", "iq"],
    spice_supported: true,
  },
  mosfet: { required_pins: ["G", "D", "S"], spice_supported: true },
  diode: { required_pins: ["a", "c"], spice_supported: true },
  bjt: { required_pins: ["C", "B", "E"], spice_supported: true },
  mcu: { spice_supported: false },
};

/** Port of registry.PASSIVE_TYPES. */
export const PASSIVE_TYPES: ReadonlySet<string> = new Set(["resistor", "capacitor"]);

/** Port of registry.SUPPORTED_SPICE_TYPES. */
export const SUPPORTED_SPICE_TYPES: ReadonlySet<string> = new Set([
  "resistor",
  "capacitor",
  "voltage_source",
  "current_source",
  "ldo",
  "generic_load",
  "mosfet",
  "diode",
  "bjt",
]);
