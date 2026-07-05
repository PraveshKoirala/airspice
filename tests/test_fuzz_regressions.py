"""Permanent regression tests for fuzzer-found parser divergences (issue #43).

The differential fuzzer (``scripts/fuzz_diff.mjs``) shrinks every divergence it
finds to a minimal reproducer and archives it under ``tests/fuzz_regressions/``
as ``<name>.air.xml`` + ``<name>.json`` (the recorded oracle/air-ts outcomes and
the filed issue). These run in NORMAL CI forever, from BOTH engines, so a fix
that removes a divergence -- or a regression that reintroduces one -- is caught.

This module is the ORACLE side: it re-evaluates each fixture through
``air.fuzz_eval.evaluate`` and asserts the oracle still produces the recorded
outcome. (air-ts re-checks the same fixtures in
``packages/air-ts/tests/fuzz_regressions.test.ts``.) It does NOT assert the two
engines agree -- that is the fuzzer's job and, for the KNOWN-divergence
fixtures, they intentionally DISAGREE until the filed issue is fixed. It pins
the oracle's half so a change to the oracle can't silently move the goalposts.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from air.fuzz_eval import evaluate

HERE = Path(__file__).resolve().parent
REGRESSION_DIR = HERE / "fuzz_regressions"


def _fixtures() -> list[Path]:
    if not REGRESSION_DIR.is_dir():
        return []
    return sorted(REGRESSION_DIR.glob("*.json"))


class FuzzRegressionTests(unittest.TestCase):
    def test_at_least_ten_regressions_archived(self) -> None:
        # Acceptance: at least 10 shrunk divergences archived (issue #43).
        self.assertGreaterEqual(
            len(_fixtures()), 10, "expected >=10 archived fuzz regressions"
        )

    def test_oracle_reproduces_recorded_outcome(self) -> None:
        for meta_path in _fixtures():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            xml_path = meta_path.with_suffix(".air.xml")
            with self.subTest(fixture=meta_path.stem):
                self.assertTrue(xml_path.exists(), f"missing {xml_path.name}")
                raw = xml_path.read_bytes()
                outcome = evaluate(raw).to_dict()
                recorded = meta["py"]
                self.assertEqual(
                    outcome["status"],
                    recorded["status"],
                    f"{meta_path.stem}: oracle status drifted",
                )
                if outcome["status"] == "accept":
                    self.assertEqual(
                        outcome["modelHash"],
                        recorded["modelHash"],
                        f"{meta_path.stem}: oracle model hash drifted",
                    )
                elif outcome["status"] == "reject":
                    self.assertEqual(
                        sorted(outcome["codes"]),
                        sorted(recorded["codes"]),
                        f"{meta_path.stem}: oracle rejection codes drifted",
                    )

    def test_security_fixtures_reject_identically(self) -> None:
        # The 'reject-agree' fixtures (SEC- security cases) must be rejected by
        # the oracle exactly as recorded -- these are the both-engines-agree half
        # of the campaign.
        for meta_path in _fixtures():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("expect") != "reject-agree":
                continue
            with self.subTest(fixture=meta_path.stem):
                raw = meta_path.with_suffix(".air.xml").read_bytes()
                outcome = evaluate(raw).to_dict()
                self.assertEqual(outcome["status"], "reject")

    def test_accept_agree_fixtures_still_agree(self) -> None:
        # The 'accept-agree' fixtures record a divergence that was FIXED upstream
        # (e.g. #80 multiple-<setup>). They are kept as regression guards: the
        # oracle must still ACCEPT with the recorded hash, and the recorded
        # air-ts hash must EQUAL it (a reverted fix would re-diverge and fail).
        for meta_path in _fixtures():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("expect") != "accept-agree":
                continue
            with self.subTest(fixture=meta_path.stem):
                raw = meta_path.with_suffix(".air.xml").read_bytes()
                outcome = evaluate(raw).to_dict()
                self.assertEqual(outcome["status"], "accept")
                self.assertEqual(outcome["modelHash"], meta["py"]["modelHash"])
                # The recorded engines agreed; the guard is that they still do.
                self.assertEqual(meta["ts"]["modelHash"], meta["py"]["modelHash"])
                self.assertFalse(meta["diverges"])


if __name__ == "__main__":
    unittest.main()
