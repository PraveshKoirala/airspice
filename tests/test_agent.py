from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air import agent  # noqa: E402
from air.agent_parsing import (  # noqa: E402
    extract_air_design,
    extract_air_patch,
    extract_json_object,
    summarize_diagnostics,
)

FAILING = ROOT / "examples" / "failing" / "bad_adc_divider.air.xml"


class ParsingTests(unittest.TestCase):
    DESIGN = '<system name="x" ir_version="0.1"></system>'
    PATCH = '<patch id="p"><reason>r</reason></patch>'

    def test_extract_design_from_fence(self) -> None:
        text = f"intro\n```xml\n{self.DESIGN}\n```\nouttro"
        self.assertEqual(extract_air_design(text), self.DESIGN)

    def test_extract_design_from_escaped_json_envelope(self) -> None:
        # The exact failure mode: model returns {"design_xml": "<system name=\"x\"...>"}
        # with backslash-escaped quotes. json.dumps reproduces it precisely.
        envelope = json.dumps({"design_xml": self.DESIGN, "architecture_summary": "s"})
        self.assertIn('\\"', envelope)  # confirm the escaping is present
        self.assertEqual(extract_air_design(envelope), self.DESIGN)

    def test_extract_design_from_raw_escaped_non_json(self) -> None:
        # Escaped XML not wrapped in JSON -> targeted unescape recovers it.
        escaped = '<system name=\\"x\\" ir_version=\\"0.1\\"></system>'
        self.assertEqual(extract_air_design(escaped), self.DESIGN)

    def test_extract_rejects_malformed_candidate(self) -> None:
        # Envelope present but the XML inside is not well-formed -> reject, not return junk.
        envelope = json.dumps({"design_xml": "<system><unclosed></system>"})
        self.assertIsNone(extract_air_design(envelope))

    def test_extract_rejects_wrong_root(self) -> None:
        self.assertIsNone(extract_air_design("<patch id='p'></patch>"))

    def test_extract_patch_from_fence_and_envelope(self) -> None:
        self.assertEqual(extract_air_patch(f"ok:\n```xml\n{self.PATCH}\n```"), self.PATCH)
        self.assertEqual(extract_air_patch(json.dumps({"patch_xml": self.PATCH})), self.PATCH)

    def test_extract_prefers_envelope_over_escaped_raw(self) -> None:
        # Both a raw escaped match and a valid envelope exist; the valid one wins.
        envelope = json.dumps({"design_xml": self.DESIGN})
        self.assertEqual(extract_air_design(envelope), self.DESIGN)

    def test_extract_returns_none_on_garbage(self) -> None:
        self.assertIsNone(extract_air_design("no xml here"))
        self.assertIsNone(extract_air_design("```xml\n<system oops\n```"))  # malformed
        self.assertIsNone(extract_air_patch(""))
        self.assertIsNone(extract_air_design(None))

    def test_extract_json_object_embedded(self) -> None:
        self.assertEqual(extract_json_object("noise {\"a\": 1} trailing"), {"a": 1})

    def test_summarize_only_errors(self) -> None:
        diags = [
            {"severity": "error", "code": "E1", "message": "bad"},
            {"severity": "warning", "code": "W1", "message": "meh"},
        ]
        summary = summarize_diagnostics(diags)
        self.assertIn("E1", summary)
        self.assertNotIn("W1", summary)


_DIVIDER = (
    '<system name="s" ir_version="0.1">'
    '<metadata><title>T</title><description>D</description><author>A</author>'
    '<created_at>2026-01-01T00:00:00Z</created_at></metadata>'
    '<nets><net id="vin" role="power"/><net id="mid" role="analog_signal"/><net id="gnd" role="ground"/></nets>'
    '<components>'
    '<component id="V1" type="voltage_source"><value>5V</value><pin name="p" net="vin"/><pin name="n" net="gnd"/></component>'
    '<component id="R1" type="resistor"><value>10k</value><pin name="1" net="vin"/><pin name="2" net="mid"/></component>'
    '<component id="R2" type="resistor"><value>10k</value><pin name="1" net="mid"/><pin name="2" net="gnd"/></component>'
    '</components>'
    '<tests><test id="t"><run duration="1ms"/><assert_voltage net="mid" min="2.4V" max="2.6V"/></test></tests>'
    '<simulation_profiles><profile id="analog_only" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>'
    "</system>"
)


class EditTests(unittest.TestCase):
    def test_mock_edit_returns_valid_design(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = agent.run_ai_edit(_DIVIDER, "change the source to 10V", Path(tmp) / "e.air.xml", provider="mock")
        self.assertTrue(result["success"])
        self.assertTrue(result["valid"], result.get("diagnostics"))
        self.assertEqual(result["mode"], "patch")

    def test_patch_edit_applies_diff(self) -> None:
        class PatchClient:
            def propose_edit_patch(self, current_xml, instruction, prior_error=None):
                return ("<patch id=\"e\"><replace path=\"/system/components/component[@id='R1']/value\">"
                        "<value>22k</value></replace></patch>")

            def generate_design(self, *a, **k):
                return ""

            def propose_patch(self, *a, **k):
                return ""

        original = agent._make_client
        agent._make_client = lambda provider, model, design, report: (
            PatchClient() if provider == "gemini" else original(provider, model, design, report)
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "e.air.xml"
                result = agent.run_ai_edit(_DIVIDER, "change R1 to 22k", out, provider="gemini")
                self.assertTrue(result["valid"], result.get("diagnostics"))
                self.assertEqual(result["mode"], "patch")  # used the diff path, not full regen
                self.assertIn("22k", out.read_text(encoding="utf-8"))
        finally:
            agent._make_client = original


class GenerationTests(unittest.TestCase):
    def test_mock_generate_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = agent.run_ai_generate("a regulated rail", Path(tmp) / "g.air.xml", provider="mock")
        self.assertTrue(result["success"])
        self.assertTrue(result["valid"], result["diagnostics"])
        self.assertEqual(result["attempts"], 1)


class SelfHealingRepairTests(unittest.TestCase):
    def test_repair_retries_until_valid(self) -> None:
        from air.auto_repair import propose_repair_patch

        class FlakyClient:
            def __init__(self) -> None:
                self.calls = 0

            def propose_patch(self, context, prior_error=None):
                self.calls += 1
                if self.calls == 1:
                    # Points at a non-existent path -> apply fails -> retry.
                    return '<patch id="bad"><replace path="/system/nope"><value>1</value></replace></patch>'
                return propose_repair_patch(FAILING, None)

            def generate_design(self, *args, **kwargs):
                return ""

        original = agent._make_client
        agent._make_client = lambda provider, model, design, report: (
            FlakyClient() if provider == "gemini" else original(provider, model, design, report)
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                result = agent.run_ai_repair(
                    FAILING, Path(tmp) / "p.xml", apply_out=Path(tmp) / "fixed.air.xml", provider="gemini"
                )
            self.assertTrue(result["success"])
            self.assertTrue(result["applied"])
            self.assertEqual(result["attempts"], 2)
        finally:
            agent._make_client = original

    def test_openai_without_key_is_structured_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = agent.run_ai_repair(FAILING, Path(tmp) / "p.xml", provider="openai")
        self.assertFalse(result["success"])
        self.assertIn("error", result)


class SourceEmittedCodeTests(unittest.TestCase):
    """Exercise the two raw-dict diagnostic codes agent.py emits directly, so
    they are covered by the registry checker's dead-code check (check 2) and the
    source-emit check (check 3) -- see registry/diagnostics.json (issue #67).

    Both codes are emitted as raw diagnostic dicts (NOT through
    DiagnosticBuilder): {"severity": "error", "code": "...", "message": str(exc)}.
    """

    def test_validate_design_xml_emits_xml_parse_error(self) -> None:
        # Malformed input makes normalize/parse raise -> the raw-dict
        # XML_PARSE_ERROR is returned (agent.py:validate_design_xml).
        ok, diagnostics = agent.validate_design_xml("this is not valid air xml <<<")
        self.assertFalse(ok)
        codes = {d["code"] for d in diagnostics}
        self.assertIn("XML_PARSE_ERROR", codes)
        emitted = next(d for d in diagnostics if d["code"] == "XML_PARSE_ERROR")
        self.assertEqual(emitted["severity"], "error")

    def test_run_ai_repair_emits_patch_apply_error(self) -> None:
        # A client whose proposed patch is not well-formed XML makes _apply_patch
        # raise -> the raw-dict PATCH_APPLY_ERROR is recorded (agent.py:run_ai_repair).
        class BadPatchClient:
            def propose_patch(self, context, prior_error=None):
                return "this is not xml, ET.fromstring will raise <<<"

            def generate_design(self, *args, **kwargs):
                return ""

        original = agent._make_client
        agent._make_client = lambda provider, model, design, report: (
            BadPatchClient() if provider == "gemini" else original(provider, model, design, report)
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                result = agent.run_ai_repair(
                    FAILING,
                    Path(tmp) / "p.xml",
                    apply_out=Path(tmp) / "fixed.air.xml",
                    provider="gemini",
                )
        finally:
            agent._make_client = original
        self.assertFalse(result["success"])
        codes = {d["code"] for d in result["diagnostics"]}
        self.assertIn("PATCH_APPLY_ERROR", codes)


class ToolSafetyTests(unittest.TestCase):
    def test_write_firmware_rejects_traversal(self) -> None:
        self.assertTrue(agent.write_firmware_file("/etc/passwd", "x").startswith("Error"))

    def test_write_firmware_requires_firmware_dir(self) -> None:
        self.assertTrue(agent.write_firmware_file("generated/x.cpp", "x").startswith("Error"))

    def test_write_firmware_rejects_bad_extension(self) -> None:
        self.assertTrue(agent.write_firmware_file("generated/firmware/x.txt", "x").startswith("Error"))

    def test_validate_design_tool(self) -> None:
        result = agent.validate_design(str(FAILING))
        self.assertIn("valid", result)
        self.assertIn("error_count", result)


class AutonomousLoopTests(unittest.TestCase):
    def test_autonomous_repair_succeeds_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = agent.run_autonomous_repair(FAILING, Path(tmp) / "auto", max_iterations=3, provider="mock")
        self.assertTrue(result["success"], result.get("message"))
        self.assertEqual(len(result["iterations"]), 1)


if __name__ == "__main__":
    unittest.main()
