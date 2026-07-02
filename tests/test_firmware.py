"""Firmware generation (hermetic) and real compilation (gated on AIR_RUN_BUILD).

The compile tests run a real PlatformIO build and so need the toolchain; they are
gated behind AIR_RUN_BUILD=1 (and pick up AIR_PLATFORMIO from .env) because a
build is slow and downloads the platform on first run. Run them with:
    AIR_RUN_BUILD=1 python -m pytest tests/test_firmware.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:  # pragma: no cover
    pass

from air.firmware import compile_firmware  # noqa: E402
from air.parser import parse_file  # noqa: E402
from air.runners import build_firmware  # noqa: E402

ADC_DESIGN = ROOT / "examples" / "esp32_battery_sensor" / "design.air.xml"
GPIO_DESIGN = ROOT / "examples" / "mixed_signal_switch" / "design.air.xml"


class FirmwareGenerationTests(unittest.TestCase):
    """The declarative task -> C++ translation must emit real code per op type."""

    def _main_cpp(self, design: Path) -> str:
        ir, _ = parse_file(design)
        out = Path(tempfile.mkdtemp())
        compile_firmware(ir, out)
        return (out / "firmware" / "src" / "main.cpp").read_text(encoding="utf-8")

    def test_adc_task_emits_analogread_and_log(self) -> None:
        cpp = self._main_cpp(ADC_DESIGN)
        self.assertIn("analogRead(", cpp)
        self.assertIn("Serial.println(", cpp)
        self.assertIn("delay(", cpp)

    def test_gpio_task_emits_pinmode_and_digitalwrite(self) -> None:
        # Regression: write_gpio used to be silently dropped (only a delay emitted).
        cpp = self._main_cpp(GPIO_DESIGN)
        self.assertIn("pinMode(2, OUTPUT)", cpp)
        self.assertIn("digitalWrite(2, HIGH)", cpp)
        self.assertIn("digitalWrite(2, LOW)", cpp)


RUN_BUILD = os.environ.get("AIR_RUN_BUILD") == "1"
_REASON = "set AIR_RUN_BUILD=1 (PlatformIO required) to compile generated firmware"


@unittest.skipUnless(RUN_BUILD, _REASON)
class FirmwareCompileTests(unittest.TestCase):
    """The generated firmware must actually compile with the real toolchain."""

    def test_adc_firmware_compiles(self) -> None:
        res = build_firmware(ADC_DESIGN, Path(tempfile.mkdtemp()))
        self.assertTrue(res.get("built"), res.get("diagnostics"))
        self.assertEqual(res.get("returncode"), 0)

    def test_gpio_firmware_compiles(self) -> None:
        res = build_firmware(GPIO_DESIGN, Path(tempfile.mkdtemp()))
        self.assertTrue(res.get("built"), res.get("diagnostics"))
        self.assertEqual(res.get("returncode"), 0)


RUN_AGENT_BUILD = RUN_BUILD and os.environ.get("AIR_RUN_E2E") == "1" and bool(os.environ.get("GEMINI_API_KEY"))


@unittest.skipUnless(RUN_AGENT_BUILD, "set AIR_RUN_BUILD=1 + AIR_RUN_E2E=1 + GEMINI_API_KEY")
class AgentFirmwareCompileTests(unittest.TestCase):
    """The full loop: agent designs an MCU system -> its firmware compiles."""

    def test_agent_mcu_design_firmware_compiles(self) -> None:
        from air.agent import run_ai_generate

        out = Path(tempfile.mkdtemp()) / "design.air.xml"
        gen = run_ai_generate(
            "An ESP32-C3 that reads a battery-sense divider on an ADC pin every 30 seconds and "
            "logs the value over serial. Include the firmware project, binding, and task.",
            out, provider="gemini",
        )
        self.assertTrue(gen["valid"], gen.get("diagnostics"))
        res = build_firmware(out, Path(tempfile.mkdtemp()))
        self.assertTrue(res.get("built"), res.get("diagnostics"))
        self.assertEqual(res.get("returncode"), 0)


if __name__ == "__main__":
    unittest.main()
