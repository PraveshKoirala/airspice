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


def load_spice_models() -> dict[str, dict[str, str]]:
    """Load part-level SPICE ``.model`` cards imported into registry/imported/.

    Returns a map keyed by the UPPERCASED model name to its stored card and
    provenance: ``{name: {"card": <.model text>, "source": <provenance>}}``.

    Only entries that carry a real, captured ``spice_card`` back a part (issue
    #60). A minimal name+type entry with no ``spice_card`` (e.g. ``BSS138`` /
    ``1N4148`` imported from a library whose card body was not captured) is NOT
    a model source and stays UNBACKED -- validation still errors on it, so
    discrimination is preserved. Files are read in sorted filename order for a
    deterministic, byte-stable map (mirrors gen-registry.mjs on the air-ts side).
    """
    registry_dir = Path(__file__).resolve().parents[4] / "registry" / "imported"
    models: dict[str, dict[str, str]] = {}
    if registry_dir.exists():
        for path in sorted(registry_dir.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            name = data.get("spice_model")
            card = data.get("spice_card")
            if name and card:
                models[str(name).upper()] = {
                    "card": card,
                    "source": data.get("source", ""),
                }
    return models


# Part-level SPICE model library: real ``.model`` cards imported from SPICE
# libraries (see registry/imported/*.json). Consulted by spice.compile_spice (to
# EMIT the card) and validation._validate_spice_models (to BACK the part).
SPICE_MODELS = load_spice_models()
