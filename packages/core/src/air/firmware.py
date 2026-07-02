from __future__ import annotations

from pathlib import Path
import re

from .artifacts import Artifact, CompileResult
from .model import SystemIR
from .registry import MCUS


import shutil

def firmware_platformio_settings(ir: SystemIR) -> dict[str, str]:
    """Resolve PlatformIO platform/framework/board for the design's MCU.

    Data-driven from the MCU registry (the ``platformio`` block) so non-ESP32
    targets such as STM32 generate a correct build file. Falls back to an
    ESP32-C3 Arduino profile when the MCU is unknown.
    """
    project = next(iter(ir.firmware_projects.values()), None)
    mcu = next((c for c in ir.components.values() if c.type == "mcu"), None)
    spec = MCUS.get(mcu.part) if mcu and mcu.part else None
    pio = spec.get("platformio", {}) if isinstance(spec, dict) else {}
    # The registry's PlatformIO board is authoritative for a known MCU part - the
    # design's free-text <board> is often an alias the toolchain rejects (e.g.
    # "esp32c3" instead of "esp32-c3-devkitm-1"). Fall back to the design's board
    # only when the MCU is unknown.
    board = pio.get("board") or (project.board if project and project.board else "") or "esp32-c3-devkitm-1"
    return {
        "platform": pio.get("platform", "espressif32"),
        "framework": pio.get("framework", "arduino"),
        "board": board,
    }


def compile_firmware(ir: SystemIR, out_dir: Path) -> CompileResult:
    firmware_dir = out_dir / "firmware"
    include_dir = firmware_dir / "include"
    src_dir = firmware_dir / "src"
    include_dir.mkdir(parents=True, exist_ok=True)
    src_dir.mkdir(parents=True, exist_ok=True)

    project = next(iter(ir.firmware_projects.values()), None)
    settings = firmware_platformio_settings(ir)
    board = settings["board"]

    platformio = firmware_dir / "platformio.ini"
    platformio.write_text(
        f"""[env:{board}]
platform = {settings["platform"]}
board = {board}
framework = {settings["framework"]}
monitor_speed = 115200
""",
        encoding="utf-8",
    )

    pinmap = include_dir / "air_pinmap.h"
    pinmap.write_text(_pinmap(ir), encoding="utf-8")

    config = include_dir / "air_config.h"
    config.write_text("#pragma once\n#define AIR_UART_BAUD 115200\n", encoding="utf-8")

    artifacts = [
        Artifact(str(platformio), "firmware_config"),
        Artifact(str(pinmap), "firmware_header"),
        Artifact(str(config), "firmware_header"),
    ]

    # Check for custom source tree
    custom_src_used = False
    if project and project.source_tree:
        src_path = Path(project.source_tree)
        if src_path.exists() and src_path.is_dir():
            for f in src_path.rglob("*"):
                if f.is_file() and f.suffix in {".cpp", ".h", ".c"}:
                    target_file = (src_dir if f.suffix in {".cpp", ".c"} else include_dir) / f.name
                    shutil.copy(f, target_file)
                    artifacts.append(Artifact(str(target_file), "firmware_source" if f.suffix in {".cpp", ".c"} else "firmware_header"))
                    custom_src_used = True

    if not custom_src_used:
        main = src_dir / "main.cpp"
        main.write_text(_main_cpp(ir), encoding="utf-8")
        artifacts.append(Artifact(str(main), "firmware_source"))

    return CompileResult(
        target="firmware",
        success=True,
        artifacts=artifacts,
        diagnostics=[],
    )


def _output_pin_numbers(ir: SystemIR) -> list[str]:
    """GPIO numbers driven by any write_gpio task op (for pinMode in setup)."""
    numbers: list[str] = []
    for task in ir.firmware_tasks.values():
        for operation in task.operations:
            if operation.get("op") == "write_gpio":
                number = _gpio_number(operation.get("pin", ""))
                if number is not None and number not in numbers:
                    numbers.append(number)
    return numbers


def _main_cpp(ir: SystemIR) -> str:
    task_blocks = [_task_block(ir, task_id) for task_id in sorted(ir.firmware_tasks)]
    loop_body = "\n".join(task_blocks).strip()
    if not loop_body:
        loop_body = 'Serial.println("air_status=idle");\n  delay(1000);'
    setup_lines = ["Serial.begin(AIR_UART_BAUD);"]
    for number in _output_pin_numbers(ir):
        setup_lines.append(f"pinMode({number}, OUTPUT);")
    setup_body = "\n  ".join(setup_lines)
    return f"""#include <Arduino.h>
#include "air_pinmap.h"
#include "air_config.h"

static long battery_raw_to_mv(int raw) {{
  return (long)raw * 3300L / 4095L;
}}

void setup() {{
  {setup_body}
}}

void loop() {{
  {loop_body}
}}
"""


def _task_block(ir: SystemIR, task_id: str) -> str:
    task = ir.firmware_tasks[task_id]
    lines = [f"// Task: {task.id}"]
    variables: set[str] = set()
    for operation in task.operations:
        op = operation.get("op")
        if op == "read_adc":
            binding_id = operation.get("binding", "")
            into = operation.get("into", "adc_raw")
            binding = ir.firmware_bindings.get(binding_id)
            pin_macro = f"AIR_{_macro(binding.signal)}_ADC_PIN" if binding else "A0"
            lines.append(f"int {into} = analogRead({pin_macro});")
            variables.add(into)
        elif op == "convert":
            into = operation.get("into", "converted")
            expr = operation.get("expr", "")
            source = _extract_first_arg(expr) or next(iter(variables), "adc_raw")
            if "battery_raw_to_mv" in expr:
                lines.append(f"long {into} = battery_raw_to_mv({source});")
            else:
                lines.append(f"long {into} = {source};")
            variables.add(into)
        elif op == "write_gpio":
            number = _gpio_number(operation.get("pin", ""))
            level = "HIGH" if operation.get("value") == "high" else "LOW"
            if number is not None:
                lines.append(f"digitalWrite({number}, {level});")
        elif op == "delay":
            duration = operation.get("duration", "")
            milliseconds = _period_to_ms(duration) if duration else 0
            if milliseconds:
                lines.append(f"delay({milliseconds});")
        elif op == "log":
            value = operation.get("value", "")
            lines.append(f'Serial.print("{value}=");')
            lines.append(f"Serial.println({value});")
    delay_ms = _period_to_ms(task.period) if task.period else 1000
    lines.append(f"delay({delay_ms});")
    return "\n  ".join(lines)


def _pinmap(ir: SystemIR) -> str:
    lines = ["#pragma once", ""]
    for binding in sorted(ir.firmware_bindings.values(), key=lambda b: b.id):
        if "ADC" in binding.channel:
            lines.append(f"#define AIR_{_macro(binding.signal)}_ADC_CHANNEL {binding.channel}")
            pin_number = _binding_pin_number(ir, binding.component, binding.channel)
            if pin_number is not None:
                lines.append(f"#define AIR_{_macro(binding.signal)}_ADC_PIN {pin_number}")
    for component in ir.components.values():
        if component.type != "mcu":
            continue
        for pin in component.pins.values():
            number = _gpio_number(pin.name)
            if pin.function == "I2C_SDA" and number is not None:
                lines.append(f"#define AIR_I2C_SDA_PIN {number}")
            if pin.function == "I2C_SCL" and number is not None:
                lines.append(f"#define AIR_I2C_SCL_PIN {number}")
    return "\n".join(lines) + "\n"


def _macro(value: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")


def _gpio_number(pin: str) -> str | None:
    match = re.match(r"GPIO(\d+)$", pin)
    return match.group(1) if match else None


def _binding_pin_number(ir: SystemIR, component_id: str, channel: str) -> str | None:
    component = ir.components.get(component_id)
    if not component:
        return None
    for pin in component.pins.values():
        if pin.function == channel:
            return _gpio_number(pin.name)
    return None


def _extract_first_arg(expr: str) -> str | None:
    match = re.search(r"\(([^)]+)\)", expr)
    return match.group(1).strip() if match else None


def _period_to_ms(period: str) -> int:
    match = re.match(r"(\d+)(ms|s)?$", period.strip())
    if not match:
        return 1000
    value = int(match.group(1))
    unit = match.group(2) or "ms"
    return value * 1000 if unit == "s" else value
