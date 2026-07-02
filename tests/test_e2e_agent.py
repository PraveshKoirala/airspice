"""End-to-end agent gauntlet against a real LLM.

These exercise the full stack: contract-attached prompt -> live model -> robust
extraction -> normalizer -> validator -> (ngspice) simulation. They are gated on
``AIR_RUN_E2E=1`` AND a GEMINI_API_KEY so the default suite stays fast and
hermetic. Run them with:  AIR_RUN_E2E=1 python -m pytest tests/test_e2e_agent.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

try:  # make the .env key available when present
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:  # pragma: no cover
    pass

RUN_E2E = os.environ.get("AIR_RUN_E2E") == "1" and bool(os.environ.get("GEMINI_API_KEY"))
_REASON = "set AIR_RUN_E2E=1 and GEMINI_API_KEY to run live-agent e2e tests"


@unittest.skipUnless(RUN_E2E, _REASON)
class GauntletGenerationTests(unittest.TestCase):
    """The model must produce a VALID design (within the self-heal budget) for
    each increasingly complex ask — proof the attached contract works."""

    def _generate(self, prompt: str):
        from air.agent import run_ai_generate

        out = Path(tempfile.mkdtemp()) / "design.air.xml"
        gen = run_ai_generate(prompt, out, provider="gemini")
        return gen, out

    def test_p1_divider_generates_and_simulates(self) -> None:
        from air.service import save_design, simulate_design

        gen, out = self._generate(
            "A resistor voltage divider: a 5V DC source feeds two equal 10k resistors in "
            "series to ground. Probe the midpoint and assert it is about 2.5V (min 2.4V max 2.6V)."
        )
        self.assertTrue(gen["valid"], gen.get("diagnostics"))
        saved = save_design(out.read_text(encoding="utf-8"), out)
        sim = simulate_design(out, saved["profile"], Path(tempfile.mkdtemp()))
        self.assertEqual(sim["status"], "passed")

    def test_p2_battery_adc_sensor(self) -> None:
        gen, _ = self._generate(
            "An ESP32-C3 battery monitor: a 3.7V battery on net v_bat feeds an LDO that outputs "
            "3.3V. A resistor divider from v_bat to a battery_sense net feeds an ADC-capable GPIO, "
            "kept under 3.3V at 4.2V. Probe battery_sense; a firmware task reads the ADC every 60s."
        )
        self.assertTrue(gen["valid"], gen.get("diagnostics"))

    def test_p3_i2c_sensor_node(self) -> None:
        gen, _ = self._generate(
            "An ESP32-C3 node with an I2C temperature sensor on the 3.3V rail, including SDA and "
            "SCL pull-up resistors to 3.3V. Power the MCU from a 3.3V rail and ground."
        )
        self.assertTrue(gen["valid"], gen.get("diagnostics"))

    def test_p4_mosfet_switch(self) -> None:
        gen, _ = self._generate(
            "An ESP32-C3 drives an NMOS MOSFET low-side switch (gate from a GPIO_OUT pin) to switch "
            "a 100mA load on a 5V rail. Add a firmware task that toggles the gate. Probe the load node."
        )
        self.assertTrue(gen["valid"], gen.get("diagnostics"))


if __name__ == "__main__":
    unittest.main()
