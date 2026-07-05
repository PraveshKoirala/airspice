"""Tests for the oracle fuzz-eval harness (issue #43, air.fuzz_eval).

``fuzz-eval`` is the oracle side of the differential fuzzer: it reports a single
input's parse outcome as accept + model hash | reject + codes | crash, matching
air-ts's ``parseOutcome``. These tests pin the outcome shapes, the never-raises
contract, and the FNV-1a-64 hash (whose vectors are shared with air-ts).
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from air.fuzz_eval import evaluate, evaluate_path, fnv1a64
from air.model_dump import model_to_dict
from air.parser import parse_string

HERE = Path(__file__).resolve().parent
CORPUS = HERE / "golden_corpus"


class Fnv1a64Tests(unittest.TestCase):
    def test_empty_string_vector(self) -> None:
        # FNV-1a 64-bit offset basis (empty input) -- same vector air-ts asserts.
        self.assertEqual(fnv1a64(""), "cbf29ce484222325")

    def test_deterministic_and_16_hex(self) -> None:
        h = fnv1a64("hello")
        self.assertEqual(h, fnv1a64("hello"))
        self.assertRegex(h, r"^[0-9a-f]{16}$")

    def test_differs_for_different_inputs(self) -> None:
        self.assertNotEqual(fnv1a64("a"), fnv1a64("b"))


class EvaluateTests(unittest.TestCase):
    def test_accept_hash_matches_dump_model_bytes(self) -> None:
        # The accept hash must be the FNV-1a-64 of the EXACT dump-model bytes, so
        # it equals air-ts's serializeModel hash for the same design.
        design = sorted(p for p in CORPUS.iterdir() if p.is_dir())[0]
        raw = (design / "input.air.xml").read_bytes()
        outcome = evaluate(raw)
        self.assertEqual(outcome.status, "accept")
        ir, _ = parse_string(raw.decode("utf-8"))
        expected_bytes = json.dumps(model_to_dict(ir), indent=2, sort_keys=True) + "\n"
        self.assertEqual(outcome.model_hash, fnv1a64(expected_bytes))

    def test_reject_bad_root(self) -> None:
        outcome = evaluate("<notsystem/>")
        self.assertEqual(outcome.status, "reject")
        self.assertIn("AirParseError", outcome.reason)

    def test_reject_malformed_xml(self) -> None:
        outcome = evaluate("<system><unclosed></system>")
        self.assertEqual(outcome.status, "reject")

    def test_reject_security_carries_sec_code(self) -> None:
        outcome = evaluate('<!DOCTYPE x><system/>')
        self.assertEqual(outcome.status, "reject")
        self.assertEqual(outcome.codes, ("SEC-001",))

    def test_never_raises_on_garbage(self) -> None:
        # A pile of non-XML bytes must produce a well-defined outcome, not raise.
        for junk in (b"\x00\x01\x02", b"not xml at all", b"<<<<", "🙂".encode("utf-8")):
            outcome = evaluate(junk)
            self.assertIn(outcome.status, {"accept", "reject", "crash"})

    def test_to_dict_shapes(self) -> None:
        acc = evaluate('<system name="t" ir_version="0.1"></system>').to_dict()
        self.assertEqual(set(acc), {"status", "modelHash"})
        rej = evaluate("<notsystem/>").to_dict()
        self.assertEqual(set(rej), {"status", "codes", "reason"})

    def test_evaluate_path(self) -> None:
        design = sorted(p for p in CORPUS.iterdir() if p.is_dir())[0]
        outcome = evaluate_path(design / "input.air.xml")
        self.assertEqual(outcome.status, "accept")


if __name__ == "__main__":
    unittest.main()
