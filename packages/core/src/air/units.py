from __future__ import annotations

import re


_UNIT_FACTORS = {
    "": 1.0,
    "f": 1e-15,
    "p": 1e-12,
    "n": 1e-9,
    "u": 1e-6,
    "m": 1e-3,
    "k": 1e3,
    "K": 1e3,
    "M": 1e6,
    "meg": 1e6,
    "Meg": 1e6,
    "MEG": 1e6,
    "g": 1e9,
    "G": 1e9,
}

_NUMBER_RE = re.compile(r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)\s*$")


def parse_quantity(value: str, expected_unit: str | None = None) -> float:
    match = _NUMBER_RE.match(value)
    if not match:
        raise ValueError(f"Invalid quantity: {value}")
    number = float(match.group(1))
    suffix = match.group(2)
    unit = expected_unit.lower() if expected_unit else ""
    if unit and suffix.lower().endswith(unit):
        suffix = suffix[: -len(unit)]
    if suffix not in _UNIT_FACTORS:
        raise ValueError(f"Unsupported unit prefix in quantity: {value}")
    return number * _UNIT_FACTORS[suffix]


def format_quantity(value: float, unit: str) -> str:
    prefixes = [
        (1e9, "G"),
        (1e6, "Meg"),
        (1e3, "k"),
        (1.0, ""),
        (1e-3, "m"),
        (1e-6, "u"),
        (1e-9, "n"),
        (1e-12, "p"),
    ]
    if abs(value) < 1e-15:
        return f"0{unit}"
    abs_value = abs(value)
    for factor, prefix in prefixes:
        if abs_value >= factor or factor == 1e-12:
            scaled = value / factor
            return f"{scaled:.6g}{prefix}{unit}"
    return f"{value:.6g}{unit}"


def spice_value(value: str) -> str:
    return value.replace("M", "Meg") if value.endswith("M") else value
