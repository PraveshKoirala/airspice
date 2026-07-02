from __future__ import annotations

import json
from pathlib import Path

_BUILTIN_MCUS = {
    "ESP32-C3": {
        "power_pins": {"3V3": "power", "GND": "ground"},
        "pins": {
            "GPIO0": {"GPIO", "ADC1_CH0", "GPIO_OUT"},
            "GPIO1": {"GPIO", "ADC1_CH1", "GPIO_OUT"},
            "GPIO2": {"GPIO", "ADC1_CH2", "GPIO_OUT"},
            "GPIO3": {"GPIO", "ADC1_CH3", "GPIO_OUT"},
            "GPIO4": {"GPIO", "ADC1_CH4", "GPIO_OUT"},
            "GPIO5": {"GPIO", "ADC1_CH5", "GPIO_OUT"},
            "GPIO8": {"GPIO", "I2C_SDA", "GPIO_OUT"},
            "GPIO9": {"GPIO", "I2C_SCL", "GPIO_OUT"},
            "TX": {"UART_TX"},
            "RX": {"UART_RX"},
        },
        "peripherals": {
            "ADC1": {"resolution_bits": 12, "vref": "3.3V"},
            "I2C0": {"supported": True},
            "UART0": {"supported": True},
        },
    },
    "ESP32-WROOM-32": {
        "power_pins": {"3V3": "power", "GND": "ground"},
        "pins": {
            "GPIO32": {"GPIO", "ADC1_CH4"},
            "GPIO33": {"GPIO", "ADC1_CH5"},
            "GPIO21": {"GPIO", "I2C_SDA"},
            "GPIO22": {"GPIO", "I2C_SCL"},
            "TX": {"UART_TX"},
            "RX": {"UART_RX"},
        },
        "peripherals": {
            "ADC1": {"resolution_bits": 12, "vref": "3.3V"},
            "I2C0": {"supported": True},
            "UART0": {"supported": True},
        },
    },
}


PASSIVE_TYPES = {"resistor", "capacitor"}
SUPPORTED_SPICE_TYPES = {"resistor", "capacitor", "voltage_source", "current_source", "ldo", "generic_load", "mosfet", "diode", "bjt"}
_BUILTIN_COMPONENTS = {
    "resistor": {"required_pins": ["1", "2"], "value_required": True, "spice_supported": True},
    "capacitor": {"required_pins": ["1", "2"], "value_required": True, "spice_supported": True},
    "voltage_source": {"required_pins": ["p", "n"], "value_required": True, "spice_supported": True},
    "current_source": {"required_pins": ["p", "n"], "value_required": True, "spice_supported": True},
    "generic_load": {"required_pins": ["p", "n"], "required_any": ["value", "current"], "spice_supported": True},
    "ldo": {"required_pins": ["in", "out", "gnd"], "required_properties": ["vout", "iout_max", "v_dropout", "iq"], "spice_supported": True},
    "mosfet": {"required_pins": ["G", "D", "S"], "spice_supported": True},
    "diode": {"required_pins": ["a", "c"], "spice_supported": True},
    "bjt": {"required_pins": ["C", "B", "E"], "spice_supported": True},
    "mcu": {"spice_supported": False},
}


def load_mcus() -> dict[str, dict[str, object]]:
    registry_dir = Path(__file__).resolve().parents[4] / "registry" / "mcu"
    mcus = dict(_BUILTIN_MCUS)
    if registry_dir.exists():
        for path in registry_dir.glob("*.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            part = data["part"]
            mcu_entry = {k: v for k, v in data.items() if k != "pins"}
            mcu_entry["pins"] = {pin: set(functions) for pin, functions in data.get("pins", {}).items()}
            mcus[part] = mcu_entry
    return mcus


MCUS = load_mcus()


def load_component_specs() -> dict[str, dict[str, object]]:
    registry_dir = Path(__file__).resolve().parents[4] / "registry" / "components"
    specs = dict(_BUILTIN_COMPONENTS)
    if registry_dir.exists():
        for path in registry_dir.glob("*.json"):
            data = json.loads(path.read_text(encoding="utf-8"))
            component_type = data["type"]
            specs[component_type] = {key: value for key, value in data.items() if key != "type"}
    return specs


COMPONENT_SPECS = load_component_specs()
