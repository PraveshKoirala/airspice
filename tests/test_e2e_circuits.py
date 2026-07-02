"""Multi-step agent E2E across 20 non-trivial circuits.

- Hermetic guard (always runs): the harness + edit plumbing work end-to-end via
  the deterministic mock provider.
- Live suite (gated on AIR_RUN_E2E=1 + GEMINI_API_KEY): every step of every
  scenario must validate and, where analog, simulate; draw steps must also meet
  their pinned numeric expectation.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))
sys.path.insert(0, str(ROOT / "tests"))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:  # pragma: no cover
    pass

from circuit_scenarios import SCENARIOS, run_scenario  # noqa: E402

RUN_E2E = os.environ.get("AIR_RUN_E2E") == "1" and bool(os.environ.get("GEMINI_API_KEY"))
_REASON = "set AIR_RUN_E2E=1 and GEMINI_API_KEY to run the live circuit E2E suite"


class HarnessSmokeTests(unittest.TestCase):
    """Deterministic: the runner drives draw->edit->simulate without a live model."""

    def test_harness_runs_all_steps_with_mock(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            results = run_scenario(SCENARIOS[0], Path(tmp), provider="mock", check_numeric=False)
        self.assertEqual(len(results), len(SCENARIOS[0].steps))
        for result in results:
            self.assertTrue(result.ok, f"{result.kind}: valid={result.valid} sim={result.sim_status}")

    def test_twenty_scenarios_defined(self) -> None:
        self.assertEqual(len(SCENARIOS), 20)
        for scenario in SCENARIOS:
            kinds = [s.kind for s in scenario.steps]
            self.assertEqual(kinds[0], "draw")
            self.assertIn("minor", kinds)
            self.assertIn("major", kinds)


@unittest.skipUnless(RUN_E2E, _REASON)
class LiveCircuitE2ETests(unittest.TestCase):
    def test_all_scenarios(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="air_e2e_"))
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario.name):
                results = run_scenario(scenario, base / scenario.name, provider="gemini")
                for index, result in enumerate(results):
                    with self.subTest(scenario=scenario.name, step=index, kind=result.kind):
                        self.assertTrue(result.valid, f"invalid: {result.error_codes} ({result.detail})")
                        if result.sim_status is not None:
                            self.assertIn(result.sim_status, {"passed", "failed"}, result.detail)
                        if result.numeric_ok is not None:
                            self.assertTrue(result.numeric_ok, result.detail)


if __name__ == "__main__":
    unittest.main()
