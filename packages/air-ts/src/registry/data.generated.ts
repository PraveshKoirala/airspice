/**
 * GENERATED FILE - do not edit by hand.
 *
 * Produced by `npm run gen:registry` (scripts/gen-registry.mjs) from the
 * on-disk registry under repo-root `registry/`. It compiles the registry
 * INTO the package so air-ts does no fs / network I/O at runtime (epic #6).
 * Regenerate after changing any registry/*.json; the committed copy is drift-
 * checked in CI (`npm run gen:registry -- --check`).
 *
 * The built-in fallbacks (Python's _BUILTIN_MCUS / _BUILTIN_COMPONENTS) live
 * in ./builtins.ts and are merged over this data in ./registry.ts, mirroring
 * registry.py's dict(_BUILTIN_...) + per-key file override.
 */

import type { ComponentSpec, McuSpec } from "./types.js";
/** Component specs loaded from registry/components/*.json (keyed by type). */
export const GENERATED_COMPONENT_SPECS: Record<string, ComponentSpec> =
{
  "capacitor": {
    "required_pins": [
      "1",
      "2"
    ],
    "value_required": true,
    "spice_supported": true
  },
  "current_source": {
    "required_pins": [
      "p",
      "n"
    ],
    "value_required": true,
    "spice_supported": true
  },
  "diode": {
    "required_pins": [
      "a",
      "c"
    ],
    "spice_supported": true
  },
  "generic_load": {
    "required_pins": [
      "p",
      "n"
    ],
    "value_required": false,
    "required_any": [
      "value",
      "current"
    ],
    "spice_supported": true
  },
  "ldo": {
    "required_pins": [
      "in",
      "out",
      "gnd"
    ],
    "required_properties": [
      "vout",
      "iout_max",
      "v_dropout",
      "iq"
    ],
    "spice_supported": true
  },
  "mcu": {
    "spice_supported": false
  },
  "mosfet": {
    "required_pins": [
      "G",
      "D",
      "S"
    ],
    "value_required": false,
    "spice_supported": true
  },
  "resistor": {
    "required_pins": [
      "1",
      "2"
    ],
    "value_required": true,
    "spice_supported": true
  },
  "voltage_source": {
    "required_pins": [
      "p",
      "n"
    ],
    "value_required": true,
    "spice_supported": true
  }
};

/** MCU specs loaded from registry/mcu/*.json (keyed by part). */
export const GENERATED_MCUS: Record<string, McuSpec> =
{
  "ESP32-C3": {
    "part": "ESP32-C3",
    "type": "mcu",
    "renode_model": "ESP32C3",
    "platformio": {
      "platform": "espressif32",
      "framework": "arduino",
      "board": "esp32-c3-devkitm-1"
    },
    "cpu": {
      "model": "RiscV32",
      "address": "0x0"
    },
    "memory": [
      {
        "name": "sram",
        "address": "0x40378000",
        "size": "0x60000"
      }
    ],
    "power_pins": {
      "3V3": "power",
      "GND": "ground"
    },
    "pins": {
      "GPIO0": [
        "GPIO",
        "ADC1_CH0",
        "GPIO_OUT"
      ],
      "GPIO1": [
        "GPIO",
        "ADC1_CH1",
        "GPIO_OUT"
      ],
      "GPIO2": [
        "GPIO",
        "ADC1_CH2",
        "GPIO_OUT"
      ],
      "GPIO3": [
        "GPIO",
        "ADC1_CH3",
        "GPIO_OUT"
      ],
      "GPIO4": [
        "GPIO",
        "ADC1_CH4",
        "GPIO_OUT"
      ],
      "GPIO5": [
        "GPIO",
        "ADC1_CH5",
        "GPIO_OUT"
      ],
      "GPIO8": [
        "GPIO",
        "I2C_SDA",
        "GPIO_OUT"
      ],
      "GPIO9": [
        "GPIO",
        "I2C_SCL",
        "GPIO_OUT"
      ],
      "TX": [
        "UART_TX"
      ],
      "RX": [
        "UART_RX"
      ]
    },
    "peripherals": {
      "ADC1": {
        "resolution_bits": 12,
        "vref": "3.3V"
      },
      "I2C0": {
        "supported": true
      },
      "UART0": {
        "supported": true
      }
    }
  },
  "ESP32-WROOM-32": {
    "part": "ESP32-WROOM-32",
    "type": "mcu",
    "platformio": {
      "platform": "espressif32",
      "framework": "arduino",
      "board": "esp32dev"
    },
    "power_pins": {
      "3V3": "power",
      "GND": "ground"
    },
    "pins": {
      "GPIO32": [
        "GPIO",
        "ADC1_CH4"
      ],
      "GPIO33": [
        "GPIO",
        "ADC1_CH5"
      ],
      "GPIO21": [
        "GPIO",
        "I2C_SDA"
      ],
      "GPIO22": [
        "GPIO",
        "I2C_SCL"
      ],
      "TX": [
        "UART_TX"
      ],
      "RX": [
        "UART_RX"
      ]
    },
    "peripherals": {
      "ADC1": {
        "resolution_bits": 12,
        "vref": "3.3V"
      },
      "I2C0": {
        "supported": true
      },
      "UART0": {
        "supported": true
      }
    }
  },
  "STM32F103": {
    "part": "STM32F103",
    "type": "mcu",
    "renode_model": "STM32F103",
    "platformio": {
      "platform": "ststm32",
      "framework": "arduino",
      "board": "bluepill_f103c8"
    },
    "cpu": {
      "model": "Cortex-M3",
      "address": "0x0"
    },
    "memory": [
      {
        "name": "flash",
        "address": "0x08000000",
        "size": "0x10000"
      },
      {
        "name": "sram",
        "address": "0x20000000",
        "size": "0x5000"
      }
    ],
    "power_pins": {
      "VDD": "power",
      "VSS": "ground"
    },
    "pins": {
      "PA0": [
        "GPIO",
        "ADC1_CH0"
      ],
      "PA1": [
        "GPIO",
        "ADC1_CH1"
      ],
      "PA9": [
        "UART1_TX"
      ],
      "PA10": [
        "UART1_RX"
      ],
      "PB6": [
        "I2C1_SCL"
      ],
      "PB7": [
        "I2C1_SDA"
      ]
    },
    "peripherals": {
      "ADC1": {
        "type": "STM32_ADC",
        "address": "0x40012400",
        "vref": "3.3V"
      },
      "UART1": {
        "type": "STM32_UART",
        "address": "0x40013800"
      },
      "I2C1": {
        "type": "STM32_I2C",
        "address": "0x40005400"
      }
    }
  }
};
