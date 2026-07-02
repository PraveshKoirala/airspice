from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air.normalizer import normalize_air_xml  # noqa: E402
from air.parser import parse_tree  # noqa: E402


def _norm(xml: str):
    return parse_tree(normalize_air_xml(xml))


class NormalizerCoercionTests(unittest.TestCase):
    """Each common LLM deviation must be coerced to canonical AIR."""

    def test_net_name_becomes_id(self) -> None:
        ir = _norm('<system name="s" ir_version="0.1"><nets><net name="vcc" role="power"/></nets></system>')
        self.assertIn("vcc", ir.nets)

    def test_component_part_becomes_type(self) -> None:
        ir = _norm(
            '<system name="s" ir_version="0.1"><components>'
            '<component id="R1" part="resistor"><value>10k</value>'
            '<pin name="1" net="a"/><pin name="2" net="b"/></component></components></system>'
        )
        self.assertEqual(ir.components["R1"].type, "resistor")
        self.assertIsNone(ir.components["R1"].part)

    def test_real_part_number_is_preserved(self) -> None:
        # type present + a real part number -> part must NOT be stripped.
        ir = _norm(
            '<system name="s" ir_version="0.1"><components>'
            '<component id="U1" type="ldo" part="LM1117"><pin name="in" net="a"/></component>'
            "</components></system>"
        )
        self.assertEqual(ir.components["U1"].type, "ldo")
        self.assertEqual(ir.components["U1"].part, "LM1117")

    def test_pins_wrapper_is_unwrapped(self) -> None:
        ir = _norm(
            '<system name="s" ir_version="0.1"><components>'
            '<component id="V1" type="voltage_source"><value>5V</value>'
            '<pins><pin name="p" net="a"/><pin name="n" net="b"/></pins></component>'
            "</components></system>"
        )
        self.assertEqual(set(ir.components["V1"].pins), {"p", "n"})

    def test_pin_node_alias_becomes_net(self) -> None:
        ir = _norm(
            '<system name="s" ir_version="0.1"><components>'
            '<component id="R1" type="resistor"><value>1k</value>'
            '<pin name="1" node="a"/><pin name="2" ref="b"/></component></components></system>'
        )
        self.assertEqual(ir.components["R1"].pins["1"].net, "a")
        self.assertEqual(ir.components["R1"].pins["2"].net, "b")

    def test_profile_without_backend_defaults_ngspice(self) -> None:
        ir = _norm(
            '<system name="s" ir_version="0.1"><simulation_profiles>'
            '<profile id="p" default="true"/></simulation_profiles></system>'
        )
        self.assertIn("ngspice", ir.simulation_profiles["p"].backends)

    def test_test_and_profile_name_become_id(self) -> None:
        ir = _norm(
            '<system name="s" ir_version="0.1">'
            '<tests><test name="t1"><run duration="1ms"/></test></tests>'
            '<simulation_profiles><profile name="pr"><backend type="ngspice"/></profile></simulation_profiles>'
            "</system>"
        )
        self.assertIn("t1", ir.tests)
        self.assertIn("pr", ir.simulation_profiles)


if __name__ == "__main__":
    unittest.main()
