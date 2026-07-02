"""4 non-trivial products through the PlatformIO + Renode tandem (gated live).

Each product's agent-authored firmware runs in Renode and must exhibit correct
stateful behavior under a time-varying injected analog stimulus: a hysteresis-
latched fuel gauge, a PI motor speed loop, a debounced voltage supervisor state
machine, and a median+EMA Schmitt-trigger detector.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

try:
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except Exception:  # pragma: no cover
    pass

RUN = os.environ.get("AIR_RUN_TANDEM") == "1" and bool(os.environ.get("GEMINI_API_KEY"))


class TandemAppsAssetsTests(unittest.TestCase):
    def test_four_apps_defined(self) -> None:
        import tandem_apps

        self.assertEqual(len(tandem_apps.APPS), 4)
        for app in tandem_apps.APPS:
            self.assertTrue(app.spec and app.phases and app.assert_fn)


@unittest.skipUnless(RUN, "set AIR_RUN_TANDEM=1 + GEMINI_API_KEY (4 agent products through Renode)")
class TandemAppsLiveTests(unittest.TestCase):
    def test_all_four_products(self) -> None:
        import tandem_apps

        self.assertEqual(tandem_apps.main(), 0)


if __name__ == "__main__":
    unittest.main()
