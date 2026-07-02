from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air.agent import run_autonomous_repair, validate_design_xml  # noqa: E402
from air.prompts import air_contract  # noqa: E402
from air.service import save_design, simulate_design, validate_design  # noqa: E402


# Every common LLM deviation stacked into one design: net `name=`, component
# `part=` for type, <pins> wrapper, pin `node=` alias, test/profile `name=`,
# and a profile with no <backend>. The hardening must absorb all of it.
MESSY_DESIGN = """<system name="messy_divider" ir_version="0.1">
  <metadata><title>M</title><description>D</description><author>A</author><created_at>2026-01-01T00:00:00Z</created_at></metadata>
  <nets>
    <net name="vin" role="power" nominal_voltage="5V"/>
    <net name="mid" role="analog_signal"/>
    <net name="gnd" role="ground"/>
  </nets>
  <components>
    <component id="V1" part="voltage_source"><value>5V</value>
      <pins><pin name="p" node="vin"/><pin name="n" node="gnd"/></pins></component>
    <component id="R1" part="resistor"><value>10k</value>
      <pin name="1" net="vin"/><pin name="2" net="mid"/></component>
    <component id="R2" part="resistor"><value>10k</value>
      <pin name="1" net="mid"/><pin name="2" net="gnd"/></component>
  </components>
  <tests>
    <test name="t"><setup><set_voltage net="vin" value="5V"/></setup>
      <run duration="1ms"/><assert_voltage net="mid" min="2.4V" max="2.6V"/></test>
  </tests>
  <simulation_profiles>
    <profile name="p" default="true"><run test="t"/></profile>
  </simulation_profiles>
</system>"""


class MessyPipelineIntegrationTests(unittest.TestCase):
    def test_messy_design_normalizes_and_validates(self) -> None:
        ok, diagnostics = validate_design_xml(MESSY_DESIGN)
        errors = [d for d in diagnostics if d.get("severity") == "error"]
        self.assertTrue(ok, f"expected clean validation, got: {errors}")

    def test_messy_design_saves_and_simulates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            design = Path(tmp) / "design.air.xml"
            saved = save_design(MESSY_DESIGN, design)
            self.assertTrue(saved["success"], saved.get("diagnostics"))
            sim = simulate_design(design, saved["profile"], Path(tmp) / "run")
            self.assertEqual(sim["status"], "passed")
            # Divider math: 5V * 10k/(10k+10k) = 2.5V on the mid net.
            mid = sim["reports"][0]["measurements"].get("mid")
            self.assertEqual(mid, "2.5V")


class AutonomousRepairIntegrationTests(unittest.TestCase):
    """Diagnose -> repair -> verify loop, deterministic via the mock provider."""

    FIXTURE = ROOT / "examples" / "failing" / "overloaded_3v3_rail.air.xml"

    def test_overloaded_rail_fires_then_repairs(self) -> None:
        pre = validate_design(self.FIXTURE)
        codes = [d["code"] for d in pre["diagnostics"] if d.get("severity") == "error"]
        self.assertEqual(codes, ["RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT"])
        with tempfile.TemporaryDirectory() as tmp:
            result = run_autonomous_repair(self.FIXTURE, Path(tmp), max_iterations=3, provider="mock")
        self.assertTrue(result["success"], result.get("message"))


class ContractCompletenessTests(unittest.TestCase):
    """The contract attached to every request must name every validator rule."""

    def test_contract_mentions_all_critical_rules(self) -> None:
        contract = air_contract()
        for token in [
            "ESP32-C3", "STM32F103",              # valid MCU parts
            "vout", "iout_max", "v_dropout", "iq",  # LDO required props
            "spice_model",                          # mosfet/bjt
            "ground", "backend",                    # structural musts
            "resistor", "capacitor", "ldo", "mosfet", "bjt", "diode",
            "assert_voltage", "assert_current", "load_step",
            "<pins>", "NEVER",                      # explicit anti-patterns
        ]:
            self.assertIn(token, contract, f"contract missing: {token}")

    def test_contract_is_ascii(self) -> None:
        self.assertTrue(all(ord(ch) < 128 for ch in air_contract()))


if __name__ == "__main__":
    unittest.main()
