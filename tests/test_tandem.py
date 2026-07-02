"""Mixed-signal tandem test: PlatformIO + ngspice + Renode together.

Gated on AIR_RUN_TANDEM=1 and a prebuilt STM32F103 ELF (needs ngspice + Renode +
the firmware binary). Asserts the firmware's USART decision matches the ngspice
divider voltage injected through the emulated ADC.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

ELF = ROOT / "generated" / "tandem" / "fw" / ".pio" / "build" / "bluepill_f103c8" / "firmware.elf"
PERIPH = ROOT / "generated" / "tandem" / "peripherals.repl"
RUN = os.environ.get("AIR_RUN_TANDEM") == "1" and ELF.exists() and PERIPH.exists()


class TandemAssetsTests(unittest.TestCase):
    """Hermetic: the tandem harness imports and its peripheral model is present."""

    def test_harness_imports(self) -> None:
        import tandem  # noqa: F401

        self.assertTrue(hasattr(tandem, "run_case"))

    def test_peripheral_model_has_rcc_flash_adc(self) -> None:
        if not PERIPH.exists():
            self.skipTest("peripherals.repl not built")
        text = PERIPH.read_text(encoding="utf-8")
        for marker in ("rcc:", "flash_ctrl:", "adc1:", "0x40012400"):
            self.assertIn(marker, text)


@unittest.skipUnless(RUN, "set AIR_RUN_TANDEM=1 (needs ngspice + Renode + prebuilt STM32 ELF)")
class TandemCoSimTests(unittest.TestCase):
    def test_high_divider_reads_high(self) -> None:
        from tandem import run_case

        self.assertTrue(run_case("high_divider", "10k", "22k"))

    def test_low_divider_reads_low(self) -> None:
        from tandem import run_case

        self.assertTrue(run_case("low_divider", "22k", "10k"))


RUN_PID = os.environ.get("AIR_RUN_TANDEM") == "1" and bool(os.environ.get("GEMINI_API_KEY"))


@unittest.skipUnless(RUN_PID, "set AIR_RUN_TANDEM=1 + GEMINI_API_KEY (agent PID firmware through Renode)")
class PidProductTandemTests(unittest.TestCase):
    """A full product: agent-authored PID firmware runs in Renode and its heater
    duty responds correctly to the injected analog (thermistor) reading."""

    def test_pid_closed_loop_responds_to_analog(self) -> None:
        import tandem_pid

        self.assertEqual(tandem_pid.main(), 0)


if __name__ == "__main__":
    unittest.main()
