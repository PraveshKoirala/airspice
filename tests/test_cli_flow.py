from __future__ import annotations

from pathlib import Path
import os
import tempfile
import unittest
from unittest import mock

# Neutralize external-tool overrides (.env may point AIR_NGSPICE/AIR_RENODE/
# AIR_PLATFORMIO at real binaries on a dev machine). Empty values keep these
# CLI tests hermetic and fast — they assert artifact generation, not that an
# external build/sim actually runs.
_NO_TOOLS = {"AIR_NGSPICE": "", "AIR_RENODE": "", "AIR_PLATFORMIO": "", "AIR_PIO": ""}

from air.cli import main
from air.firmware import compile_firmware
from air.graph import build_graph_data, compile_graph
from air.parser import parse_file
from air.simulator import simulate_analog
from air.spice import compile_spice
from air.templates import render_template
from air.validation import has_errors, validate_ir, validate_tree
from air.waveforms import list_waveforms, read_waveform


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "esp32_battery_sensor" / "design.air.xml"
FAILING = ROOT / "examples" / "failing"
ANALOG = ROOT / "examples" / "analog_primitives" / "design.air.xml"
GOLDEN = ROOT / "tests" / "golden"


class CliFlowTests(unittest.TestCase):
    def test_example_validates(self) -> None:
        ir, tree = parse_file(EXAMPLE)
        diagnostics = validate_tree(tree) + validate_ir(ir)
        self.assertFalse(has_errors(diagnostics))

    def test_simulation_passes_with_builtin_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ir, _ = parse_file(EXAMPLE)
            result = simulate_analog(ir, "analog_only", Path(tmp) / "generated")
            self.assertEqual(result["status"], "passed")
            report = result["reports"][0]
            self.assertEqual(report["measurements"]["battery_sense"], "1.04211V")

    def test_cli_compile_spice(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rc = main(["compile", str(EXAMPLE), "--target", "spice", "--out-dir", str(Path(tmp) / "generated")])
            self.assertEqual(rc, 0)
            self.assertTrue((Path(tmp) / "generated" / "spice" / "main.cir").exists())

    def test_bad_adc_divider_fails_simulation_then_patch_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            bad = FAILING / "bad_adc_divider.air.xml"
            rc = main(["simulate", str(bad), "--profile", "analog_only", "--out-dir", str(tmp_path / "bad")])
            self.assertEqual(rc, 1)
            patched = tmp_path / "patched.air.xml"
            rc = main(["patch", str(bad), str(FAILING / "fix_bad_adc_divider.patch.xml"), "--out", str(patched)])
            self.assertEqual(rc, 0)
            rc = main(["simulate", str(patched), "--profile", "analog_only", "--out-dir", str(tmp_path / "fixed")])
            self.assertEqual(rc, 0)

    def test_validation_failing_examples(self) -> None:
        expected = {
            "missing_ground.air.xml": "MISSING_GROUND",
            "invalid_pin_function.air.xml": "UNSUPPORTED_PIN_FUNCTION",
            "i2c_without_pullups.air.xml": "I2C_PULLUPS_NOT_DECLARED",
            "overloaded_3v3_rail.air.xml": "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT",
        }
        for filename, code in expected.items():
            ir, tree = parse_file(FAILING / filename)
            diagnostics = validate_tree(tree) + validate_ir(ir)
            self.assertIn(code, {diagnostic.code for diagnostic in diagnostics})

    def test_repair_context_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "repair.json"
            rc = main(["repair-context", str(FAILING / "bad_adc_divider.air.xml"), "--out", str(out)])
            self.assertEqual(rc, 0)
            self.assertIn("allowed_patch_ops", out.read_text(encoding="utf-8"))

    def test_template_init_explain_and_preview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            template = tmp_path / "divider.air.xml"
            rc = main(["generate-template", "voltage-divider", "--out", str(template)])
            self.assertEqual(rc, 0)
            rc = main(["validate", str(template)])
            self.assertEqual(rc, 0)
            rc = main(["init", str(tmp_path / "proj"), "--template", "esp32-i2c-sensor"])
            self.assertEqual(rc, 0)
            self.assertTrue((tmp_path / "proj" / "patches").exists())
            rc = main(["explain", str(tmp_path / "proj" / "design.air.xml")])
            self.assertEqual(rc, 0)
            rc = main(["patch-preview", str(FAILING / "bad_adc_divider.air.xml"), str(FAILING / "fix_bad_adc_divider.patch.xml")])
            self.assertEqual(rc, 0)

    def test_deterministic_repair_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            patch = tmp_path / "repair.patch.xml"
            fixed = tmp_path / "fixed.air.xml"
            rc = main(["repair", str(FAILING / "bad_adc_divider.air.xml"), "--out", str(patch), "--apply-out", str(fixed)])
            self.assertEqual(rc, 0)
            self.assertIn("<patch", patch.read_text(encoding="utf-8"))
            rc = main(["simulate", str(fixed), "--profile", "analog_only", "--out-dir", str(tmp_path / "generated")])
            self.assertEqual(rc, 0)

    def test_analog_primitives_simulate_with_current_stats(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ir, _ = parse_file(ANALOG)
            result = simulate_analog(ir, "analog_only", Path(tmp) / "generated")
            self.assertEqual(result["status"], "passed")
            report = result["reports"][0]
            self.assertEqual(report["measurements"]["i(LOAD_A)"], "10mA")
            self.assertIn("measurement_stats", report)
            self.assertEqual(report["measurement_stats"]["mid"]["max"], "2.5V")

    def test_golden_spice_firmware_and_graph_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            design = tmp_path / "divider.air.xml"
            design.write_text(render_template("voltage-divider"), encoding="utf-8")
            ir, _ = parse_file(design)
            test = next(iter(ir.tests.values()))
            compile_spice(ir, tmp_path / "generated", test)
            compile_firmware(ir, tmp_path / "generated")
            compile_graph(ir, tmp_path / "generated" / "graph.json")
            self.assertEqual(
                (tmp_path / "generated" / "spice" / "main.cir").read_text(encoding="utf-8"),
                (GOLDEN / "voltage_divider_main.cir").read_text(encoding="utf-8"),
            )
            self.assertEqual(
                (tmp_path / "generated" / "firmware" / "src" / "main.cpp").read_text(encoding="utf-8"),
                (GOLDEN / "firmware_main.cpp").read_text(encoding="utf-8"),
            )
            self.assertEqual(
                (tmp_path / "generated" / "graph.json").read_text(encoding="utf-8"),
                (GOLDEN / "voltage_divider_graph.json").read_text(encoding="utf-8"),
            )

    def test_check_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rc = main(["check", str(EXAMPLE), "--out-dir", str(Path(tmp) / "check")])
            self.assertEqual(rc, 0)
            rc = main(["check", str(FAILING / "bad_adc_divider.air.xml"), "--out-dir", str(Path(tmp) / "bad")])
            self.assertEqual(rc, 1)
            self.assertTrue((Path(tmp) / "bad" / "repair_context.json").exists())

    def test_project_json_and_json_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            rc = main(["init", str(project), "--template", "voltage-divider", "--json"])
            self.assertEqual(rc, 0)
            self.assertTrue((project / "air.project.json").exists())
            rc = main(["project-info", "--project", str(project), "--json"])
            self.assertEqual(rc, 0)
            rc = main(["compile", str(project / "design.air.xml"), "--target", "spice", "--out-dir", str(project / "generated"), "--json"])
            self.assertEqual(rc, 0)
            fixed = Path(tmp) / "ai_fixed.air.xml"
            rc = main(["ai-repair", str(FAILING / "bad_adc_divider.air.xml"), "--out", str(Path(tmp) / "ai.patch.xml"), "--apply-out", str(fixed), "--json"])
            self.assertEqual(rc, 0)
            self.assertTrue(fixed.exists())

    def test_firmware_generates_declared_task_code(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ir, _ = parse_file(EXAMPLE)
            compile_firmware(ir, Path(tmp) / "generated")
            main_cpp = (Path(tmp) / "generated" / "firmware" / "src" / "main.cpp").read_text(encoding="utf-8")
            pinmap = (Path(tmp) / "generated" / "firmware" / "include" / "air_pinmap.h").read_text(encoding="utf-8")
            self.assertIn("analogRead(AIR_BATTERY_VOLTAGE_ADC_PIN)", main_cpp)
            self.assertIn('Serial.print("battery_mv=");', main_cpp)
            self.assertIn("#define AIR_BATTERY_VOLTAGE_ADC_PIN 4", pinmap)

    def test_api_app_imports_when_dependencies_available(self) -> None:
        try:
            import air.api as api
            from fastapi.testclient import TestClient
        except RuntimeError:
            self.skipTest("FastAPI dependencies are not installed")
        self.assertTrue(hasattr(api, "app"))
        client = TestClient(api.app)
        response = client.post("/validate", json={"design": str(EXAMPLE)})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])
        response = client.post("/repair-session/start", json={"design": str(FAILING / "bad_adc_divider.air.xml"), "out_dir": str(ROOT / "generated" / "test_api_repair_session")})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["success"])

    def test_graph_infers_missing_net_nodes_for_renderable_edges(self) -> None:
        xml = """<system name="implicit_net_graph" ir_version="0.1">
  <metadata><title>Implicit Net Graph</title></metadata>
  <nets><net id="gnd" role="ground"/></nets>
  <components>
    <component id="Q1" type="mosfet"><pin name="D" net="lamp"/><pin name="S" net="gnd"/><pin name="G" node="sense"/></component>
  </components>
  <tests><test id="noop"><run duration="1ms"/></test></tests>
  <simulation_profiles><profile id="analog_only"><backend type="ngspice"/><run test="noop"/></profile></simulation_profiles>
</system>"""
        from air.parser import parse_string
        ir, _ = parse_string(xml)
        graph = build_graph_data(ir)
        node_ids = {node["id"] for node in graph["nodes"]}
        self.assertIn("net:lamp", node_ids)
        self.assertIn("net:sense", node_ids)
        self.assertTrue(all(edge["target"] in node_ids for edge in graph["edges"]))

    def test_generic_ai_xml_is_normalized_to_air_wiring(self) -> None:
        xml = """<system name="dark_activated_lamp" ir_version="0.1">
  <metadata><title>Dark-Activated Transistor Lamp</title><author>Expert Engineer</author><created_at>2024-11-23</created_at></metadata>
  <components>
    <component id="V1" type="voltage_source"><parameter name="voltage" value="9"/></component>
    <component id="R_top" type="resistor"><parameter name="resistance" value="10000"/></component>
    <component id="R_ldr" type="resistor"><parameter name="resistance" value="100000"/></component>
    <component id="R_bulb" type="resistor"><parameter name="resistance" value="100"/></component>
    <component id="Q1" type="bjt"><parameter name="type" value="npn"/></component>
  </components>
  <nets>
    <net id="VCC"><node component="V1" pin="p"/><node component="R_top" pin="1"/><node component="R_bulb" pin="1"/></net>
    <net id="GND"><node component="V1" pin="n"/><node component="R_ldr" pin="2"/><node component="Q1" pin="e"/></net>
    <net id="base_node"><node component="R_top" pin="2"/><node component="R_ldr" pin="1"/><node component="Q1" pin="b"/></net>
    <net id="col_node"><node component="R_bulb" pin="2"/><node component="Q1" pin="c"/></net>
  </nets>
  <analog><subsystem id="main"><probe id="v_base" net="base_node" quantity="voltage"/><probe id="v_col" net="col_node" quantity="voltage"/></subsystem></analog>
  <simulation_profiles><simulation_profile id="analog_only" solver="ngspice"/></simulation_profiles>
  <tests><test id="dark_on_test"><assert_voltage net="col_node" min="0.0" max="0.5"/><assert_voltage net="base_node" min="0.6" max="0.85"/></test></tests>
</system>"""
        from air.parser import parse_string
        ir, tree = parse_string(xml)
        diagnostics = validate_tree(tree) + validate_ir(ir)
        self.assertFalse(has_errors(diagnostics))
        self.assertEqual(ir.components["V1"].value, "9V")
        self.assertEqual(ir.components["R_top"].value, "10000")
        self.assertEqual(ir.components["Q1"].pins["C"].net, "col_node")
        self.assertEqual(ir.components["Q1"].pins["B"].net, "base_node")
        self.assertEqual(ir.components["Q1"].pins["E"].net, "GND")
        graph = build_graph_data(ir)
        self.assertEqual(len(graph["edges"]), 11)
        self.assertTrue(all(edge["target"] in {node["id"] for node in graph["nodes"]} for edge in graph["edges"]))

    def test_waveform_listing_and_readback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "generated"
            ir, _ = parse_file(EXAMPLE)
            result = simulate_analog(ir, "analog_only", out_dir)
            self.assertTrue(result["success"])
            listing = list_waveforms(out_dir)
            names = [item["name"] for item in listing["waveforms"]]
            self.assertIn("battery_adc_nominal_battery_sense.csv", names)
            waveform = read_waveform(out_dir, "battery_adc_nominal_battery_sense.csv")
            self.assertTrue(waveform["success"])
            self.assertEqual(waveform["test"], "battery_adc_nominal")
            self.assertEqual(waveform["signal"], "battery_sense")
            self.assertGreaterEqual(len(waveform["points"]), 2)

    @mock.patch.dict(os.environ, _NO_TOOLS)
    def test_runners_and_repair_session_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            rc = main(["build-firmware", str(EXAMPLE), "--out-dir", str(tmp_path / "firmware"), "--json"])
            self.assertEqual(rc, 1)
            self.assertTrue((tmp_path / "firmware" / "firmware" / "src" / "main.cpp").exists())
            rc = main(["run-renode", str(EXAMPLE), "--out-dir", str(tmp_path / "renode"), "--json"])
            self.assertEqual(rc, 1)
            self.assertTrue((tmp_path / "renode" / "renode" / "run.resc").exists())
            session_dir = tmp_path / "session"
            rc = main(["repair-session-start", str(FAILING / "bad_adc_divider.air.xml"), "--out-dir", str(session_dir), "--json"])
            self.assertEqual(rc, 0)
            fixed = tmp_path / "session.fixed.air.xml"
            rc = main(["repair-session-apply", str(FAILING / "bad_adc_divider.air.xml"), str(session_dir / "proposed.patch.xml"), "--out", str(fixed), "--out-dir", str(tmp_path / "session_check"), "--json"])
            self.assertEqual(rc, 0)
            self.assertTrue(fixed.exists())

    def test_openai_provider_returns_structured_failure_without_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rc = main(["ai-repair", str(FAILING / "bad_adc_divider.air.xml"), "--provider", "openai", "--out", str(Path(tmp) / "openai.patch.xml"), "--json"])
            self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
