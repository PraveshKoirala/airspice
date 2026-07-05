"""Oracle-side XML security contract tests (issue #43, docs/xml_security.md).

Drives the real oracle gate (``air.xml_security`` + ``air.parser.parse_string`` /
``parse_file``) against the shared hostile-XML fixtures in ``tests/xml_security/``
and asserts each is REJECTED with the registered ``SEC-`` code named in the
manifest. The air-ts port runs the SAME fixtures through the SAME contract
(``packages/air-ts/tests/xml_security.test.ts``); the manifest is the single
source of truth both consume.

This is also where every ``SEC-`` code is EXERCISED for the diagnostics-registry
dead-code check (``scripts/check_diagnostics.py`` check 2): each ``SEC-NNN``
string appears in an assertion below, so the checker credits it as covered.

Acceptance evidence: the billion-laughs case is timed and asserted to reject in
under 100 ms (i.e. on the DOCTYPE/ENTITY declaration, BEFORE any expansion).
"""

from __future__ import annotations

import json
import time
import unittest
from pathlib import Path

from air.parser import parse_file, parse_string
from air.xml_security import (
    MAX_ATTR_COUNT,
    MAX_ATTR_VALUE_LEN,
    MAX_INPUT_BYTES,
    XmlParseRejection,
    XmlSecurityError,
    enforce_xml_security,
)

HERE = Path(__file__).resolve().parent
FIXTURE_ROOT = HERE / "xml_security"
MANIFEST = FIXTURE_ROOT / "manifest.json"


def _load_manifest() -> list[dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["fixtures"]


def _generate(kind: str) -> bytes:
    """Build the in-test hostile inputs that are too big / binary to commit."""
    if kind == "oversized":
        pad = "x" * (MAX_INPUT_BYTES + 1)
        return f'<system name="{pad}" ir_version="0.1"></system>'.encode("utf-8")
    if kind == "utf16":
        doc = '<?xml version="1.0"?><system name="t" ir_version="0.1"></system>'
        return doc.encode("utf-16")  # includes a BOM
    if kind == "many_attributes":
        attrs = " ".join(f'a{i}="1"' for i in range(MAX_ATTR_COUNT + 1))
        return f"<system {attrs}></system>".encode("utf-8")
    if kind == "long_attr_value":
        val = "y" * (MAX_ATTR_VALUE_LEN + 1)
        return f'<system name="{val}" ir_version="0.1"></system>'.encode("utf-8")
    raise ValueError(f"unknown generated fixture: {kind}")


def _reject_code(raw: bytes) -> str:
    """Run the gate on raw bytes and return the SEC- code it rejects with.

    Fails the test if the input is NOT rejected by the security gate. A
    malformed-XML rejection (XmlParseRejection) is returned as the sentinel
    'PARSE' since it carries no SEC- code.
    """
    try:
        enforce_xml_security(raw)
    except XmlSecurityError as exc:
        return exc.code
    except XmlParseRejection:
        return "PARSE"
    raise AssertionError("input was NOT rejected by the security gate")


class HostileFixtureTests(unittest.TestCase):
    """Every hostile fixture is rejected with its manifest-declared SEC- code."""

    def test_all_hostile_fixtures_rejected_with_expected_code(self) -> None:
        for entry in _load_manifest():
            with self.subTest(fixture=entry["name"]):
                if "file" in entry:
                    raw = (FIXTURE_ROOT / entry["file"]).read_bytes()
                else:
                    raw = _generate(entry["generated"])
                code = _reject_code(raw)
                self.assertEqual(
                    code,
                    entry["expect_code"],
                    f"{entry['name']}: expected {entry['expect_code']}, got {code}",
                )

    def test_billion_laughs_rejected_under_100ms(self) -> None:
        raw = (FIXTURE_ROOT / "fixtures" / "billion_laughs.air.xml").read_bytes()
        start = time.perf_counter()
        code = _reject_code(raw)
        elapsed_ms = (time.perf_counter() - start) * 1000.0
        # Rejected on the DOCTYPE declaration (SEC-001), BEFORE any expansion.
        self.assertEqual(code, "SEC-001")
        self.assertLess(
            elapsed_ms,
            100.0,
            f"billion-laughs took {elapsed_ms:.3f} ms (must reject <100 ms, "
            "i.e. before expansion)",
        )

    def test_parse_file_gate_rejects_deep_nesting(self) -> None:
        # The gate runs through the real parse_file entry point too.
        path = FIXTURE_ROOT / "fixtures" / "deep_nesting.air.xml"
        with self.assertRaises(XmlSecurityError) as cm:
            parse_file(path)
        self.assertEqual(cm.exception.code, "SEC-003")


class SecCodeCoverageTests(unittest.TestCase):
    """Exercise every SEC- code through the real gate (registry check-2 credit).

    Each SEC-NNN literal appears in an assertion so
    scripts/check_diagnostics.py credits it as covered.
    """

    def _code_for(self, raw: bytes | str) -> str:
        return _reject_code(raw if isinstance(raw, bytes) else raw.encode("utf-8"))

    def test_sec_001_doctype_and_entity(self) -> None:
        self.assertEqual(self._code_for('<!DOCTYPE x><system/>'), "SEC-001")
        self.assertEqual(self._code_for('<!ENTITY a "b"><system/>'), "SEC-001")

    def test_sec_002_oversized(self) -> None:
        self.assertEqual(self._code_for(_generate("oversized")), "SEC-002")

    def test_sec_003_depth(self) -> None:
        deep = "<system>" + "<a>" * 100 + "</a>" * 100 + "</system>"
        self.assertEqual(self._code_for(deep), "SEC-003")

    def test_sec_004_attribute_count(self) -> None:
        self.assertEqual(self._code_for(_generate("many_attributes")), "SEC-004")

    def test_sec_005_attribute_value_length(self) -> None:
        self.assertEqual(self._code_for(_generate("long_attr_value")), "SEC-005")

    def test_sec_006_element_count(self) -> None:
        # Force the element-count cap below the real limit is not possible without
        # touching the module, so build a document with many siblings; to keep
        # the test fast we monkeypatch the limit down for this one assertion.
        from air import xml_security

        original = xml_security.MAX_ELEMENT_COUNT
        try:
            xml_security.MAX_ELEMENT_COUNT = 5
            many = "<system>" + "<a/>" * 20 + "</system>"
            self.assertEqual(self._code_for(many), "SEC-006")
        finally:
            xml_security.MAX_ELEMENT_COUNT = original

    def test_sec_007_encoding(self) -> None:
        self.assertEqual(self._code_for(_generate("utf16")), "SEC-007")
        self.assertEqual(
            self._code_for('<?xml version="1.0" encoding="ISO-8859-1"?><system/>'),
            "SEC-007",
        )

    def test_sec_008_invalid_charref(self) -> None:
        self.assertEqual(
            self._code_for('<system name="t"><t>a&#8;b</t></system>'), "SEC-008"
        )


class BenignInputUnaffectedTests(unittest.TestCase):
    """The security gate must NOT change behavior for benign inputs.

    A UTF-8 BOM is tolerated; a normal design parses unchanged. This is the
    oracle-first evidence: hostile inputs are refused, benign ones are not.
    """

    def test_utf8_bom_is_tolerated(self) -> None:
        text = enforce_xml_security(
            '﻿<system name="t" ir_version="0.1"></system>'.encode("utf-8")
        )
        self.assertTrue(text.lstrip("﻿").startswith("<system"))

    def test_benign_design_parses(self) -> None:
        ir, _ = parse_string('<system name="t" ir_version="0.1"></system>')
        self.assertEqual(ir.name, "t")

    def test_corpus_design_still_parses(self) -> None:
        corpus = HERE / "golden_corpus"
        designs = sorted(p for p in corpus.iterdir() if p.is_dir())
        self.assertTrue(designs, "no corpus designs found")
        for design in designs:
            input_path = design / "input.air.xml"
            if not input_path.exists():
                continue
            with self.subTest(design=design.name):
                ir, _ = parse_file(input_path)
                self.assertIsNotNone(ir)


if __name__ == "__main__":
    unittest.main()
