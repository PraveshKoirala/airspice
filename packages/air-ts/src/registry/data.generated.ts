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

import type { ComponentSpec, McuSpec, SpiceModelEntry } from "./types.js";
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
  "ATmega328P": {
    "part": "ATmega328P",
    "type": "mcu",
    "renode_model": "ATmega328P",
    "platformio": {
      "platform": "atmelavr",
      "framework": "arduino",
      "board": "uno"
    },
    "cpu": {
      "model": "AVR8",
      "address": "0x0"
    },
    "memory": [
      {
        "name": "flash",
        "address": "0x0000",
        "size": "0x8000"
      },
      {
        "name": "sram",
        "address": "0x0100",
        "size": "0x0800"
      }
    ],
    "power_pins": {
      "VCC": "power",
      "GND": "ground"
    },
    "pins": {
      "A0": [
        "GPIO",
        "ADC0",
        "ADC1_CH0"
      ],
      "A1": [
        "GPIO",
        "ADC1",
        "ADC1_CH1"
      ],
      "A2": [
        "GPIO",
        "ADC2",
        "ADC1_CH2"
      ],
      "A3": [
        "GPIO",
        "ADC3",
        "ADC1_CH3"
      ],
      "A4": [
        "GPIO",
        "ADC4",
        "ADC1_CH4",
        "I2C_SDA"
      ],
      "A5": [
        "GPIO",
        "ADC5",
        "ADC1_CH5",
        "I2C_SCL"
      ],
      "D0": [
        "GPIO",
        "UART_RX"
      ],
      "D1": [
        "GPIO",
        "UART_TX"
      ],
      "D2": [
        "GPIO",
        "GPIO_OUT"
      ],
      "D3": [
        "GPIO",
        "GPIO_OUT",
        "PWM"
      ],
      "D4": [
        "GPIO",
        "GPIO_OUT"
      ],
      "D5": [
        "GPIO",
        "GPIO_OUT",
        "PWM"
      ],
      "D6": [
        "GPIO",
        "GPIO_OUT",
        "PWM"
      ],
      "D7": [
        "GPIO",
        "GPIO_OUT"
      ],
      "D8": [
        "GPIO",
        "GPIO_OUT"
      ],
      "D9": [
        "GPIO",
        "GPIO_OUT",
        "PWM"
      ],
      "D10": [
        "GPIO",
        "GPIO_OUT",
        "PWM",
        "SPI_SS"
      ],
      "D11": [
        "GPIO",
        "GPIO_OUT",
        "PWM",
        "SPI_MOSI"
      ],
      "D12": [
        "GPIO",
        "GPIO_OUT",
        "SPI_MISO"
      ],
      "D13": [
        "GPIO",
        "GPIO_OUT",
        "SPI_SCK"
      ],
      "AREF": [
        "ADC_VREF"
      ]
    },
    "peripherals": {
      "ADC1": {
        "resolution_bits": 10,
        "vref": "5.0V"
      },
      "I2C0": {
        "supported": true
      },
      "SPI0": {
        "supported": true
      },
      "UART0": {
        "supported": true
      }
    },
    "provenance": {
      "source": "Microchip ATmega328P datasheet (DS40002061B), Arduino Uno Rev3 pin mapping (arduino.cc/en/Reference/PinMapping168to328)",
      "notes": "Pin names use the Arduino Uno silkscreen convention (A0-A5, D0-D13). ADC channel functions are given both as datasheet names (ADC0-ADC5) and as the engine's generic 'ADC1_CH<n>' function tokens so ADC bindings validate identically to the ESP32/STM32 entries. ADC is 10-bit with AVCC (5.0 V) as the default reference; AREF selects an external reference. PWM-capable pins (D3,D5,D6,D9,D10,D11) are the Timer0/1/2 analogWrite() pins. I2C is on A4 (SDA) / A5 (SCL); hardware SPI on D10-D13; UART0 on D0/D1."
    }
  },
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

/** Part-level SPICE .model cards from registry/imported/*.json (keyed by
 * UPPERCASE model name; only entries carrying a captured card). */
export const GENERATED_SPICE_MODELS: Record<string, SpiceModelEntry> =
{
  "2N2222": {
    "card": ".model 2N2222 NPN(IS=1E-14 VAF=100 BF=200 IKF=0.3 XTB=1.5 BR=3 CJC=8E-12 CJE=25E-12 TR=100E-9 TF=400E-12 ITF=1 VTF=2 XTF=3 RB=10 RC=.3 RE=.2 Vceo=30 Icrating=800m)",
    "source": "samples/standard.bjt (Philips)"
  },
  "2N2907": {
    "card": ".model 2N2907 PNP(IS=1E-14 VAF=120 BF=250 IKF=0.3 XTB=1.5 BR=3 CJC=8E-12 CJE=30E-12 TR=100E-9 TF=400E-12 ITF=1 VTF=2 XTF=3 RB=10 RC=.3 RE=.2 Vceo=40 Icrating=600m)",
    "source": "samples/standard.bjt (Philips)"
  },
  "2N3904": {
    "card": ".model 2N3904 NPN(IS=1E-14 VAF=100 Bf=300 IKF=0.4 XTB=1.5 BR=4 CJC=4E-12 CJE=8E-12 RB=20 RC=0.1 RE=0.1 TR=250E-9 TF=350E-12 ITF=1 VTF=2 XTF=3 Vceo=40 Icrating=200m)",
    "source": "samples/standard.bjt (Philips)"
  },
  "2N3906": {
    "card": ".model 2N3906 PNP(IS=1E-14 VAF=100 BF=200 IKF=0.4 XTB=1.5 BR=4 CJC=4.5E-12 CJE=10E-12 RB=20 RC=0.1 RE=0.1 TR=250E-9 TF=350E-12 ITF=1 VTF=2 XTF=3 Vceo=40 Icrating=200m)",
    "source": "samples/standard.bjt (Philips)"
  },
  "2N4124": {
    "card": ".model 2N4124 NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=495 Ne=1.28 Ise=6.734f Ikf=69.35m Xtb=1.5 Br=.7214 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=238.3n Tf=301.3p Itf=.4 Vtf=4 Xtf=2 Rb=10 Vceo=25 Icrating=200m)",
    "source": "samples/standard.bjt (Fairchild)"
  },
  "2N4126": {
    "card": ".model 2N4126 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=203.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.924 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.23n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10 Rb=10 Vceo=25 Icrating=200m)",
    "source": "samples/standard.bjt (Fairchild)"
  },
  "BC547B": {
    "card": ".model BC547B NPN(IS=2.39E-14 NF=1.008 ISE=3.545E-15 NE=1.541 BF=294.3 IKF=0.1357 VAF=63.2 NR=1.004 ISC=6.272E-14 NC=1.243 BR=7.946 IKR=0.1144 VAR=25.9 RB=1 IRB=1.00E-06 RBM=1 RE=0.4683 RC=0.85 XTB=0 EG=1.11 XTI=3 CJE=1.358E-11 VJE=0.65 MJE=0.3279 TF=4.391E-10 XTF=120 VTF=2.643 ITF=0.7495 PTF=0 CJC=3.728E-12 VJC=0.3997 MJC=0.2955 XCJC=0.6193 TR=1.00E-32 CJS=0 VJS=0.75 MJS=0.333 FC=0.9579 Vceo=45 Icrating=100m)",
    "source": "samples/standard.bjt (Philips)"
  },
  "FZT849": {
    "card": ".model FZT849 NPN(IS=5.8591E-13 NF=0.9919 BF=230 IKF=18 VAF=90 ISE=2.0067E-13 NE=1.4 NR=0.9908 BR=180 IKR=6.8 VAR=20 ISC=5.3E-13 NC=1.46 RB=0.023 RE=0.0223 RC=0.015 CJC=200E-12 MJC=0.3006 VJC=0.3532 CJE=1.21E-9 TF=1.07E-9 TR=9.3E-9 Vceo=30 Icrating=7)",
    "source": "samples/standard.bjt (Zetex)"
  },
  "ZTX1048A": {
    "card": ".model ZTX1048A NPN(IS=13.73E-13 NF=1.0 BF=550 IKF=8.0 VAF=120 ISE=2.6E-13 NE=1.38 NR=1.0 BR=300 IKR=6 VAR=15 ISC=1.6E-12 NC=1.4 RB=0.1 RE=0.022 RC=0.010 CJC=136E-12 CJE=559.1E-12 MJC=0.267 MJE=0.299 VJC=0.420 VJE=0.533 TF=600E-12 TR=3E-9 Vceo=17.5 Icrating=5)",
    "source": "samples/standard.bjt (Zetex)"
  }
};
