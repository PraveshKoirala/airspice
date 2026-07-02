"""End-to-end: 5 real products, each with sophisticated custom firmware that COMPILES.

Gated on AIR_RUN_E2E=1 + AIR_RUN_BUILD=1 + GEMINI_API_KEY (needs both the live model
and the PlatformIO toolchain). Run with:
    AIR_RUN_E2E=1 AIR_RUN_BUILD=1 python -m pytest tests/test_e2e_firmware_projects.py
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

from firmware_projects import PRODUCTS, run_product  # noqa: E402

RUN = (
    os.environ.get("AIR_RUN_E2E") == "1"
    and os.environ.get("AIR_RUN_BUILD") == "1"
    and bool(os.environ.get("GEMINI_API_KEY"))
)
_REASON = "set AIR_RUN_E2E=1 + AIR_RUN_BUILD=1 + GEMINI_API_KEY to run the product firmware E2E"


class HermeticSmokeTests(unittest.TestCase):
    def test_five_products_defined(self) -> None:
        self.assertEqual(len(PRODUCTS), 5)
        for product in PRODUCTS:
            self.assertTrue(product.hardware_prompt and product.firmware_spec)
            self.assertTrue(product.must_contain)


@unittest.skipUnless(RUN, _REASON)
class ProductFirmwareE2ETests(unittest.TestCase):
    def test_products(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="air_products_"))
        for product in PRODUCTS:
            with self.subTest(product=product.name):
                result = run_product(product, base / product.name, provider="gemini")
                self.assertTrue(result.design_valid, "hardware design invalid")
                self.assertTrue(result.compiled, f"firmware did not compile: {result.detail}")
                self.assertEqual(result.missing_primitives, [], "firmware missing required I/O")
                self.assertFalse(result.too_short, "firmware looks like a stub")


if __name__ == "__main__":
    unittest.main()
