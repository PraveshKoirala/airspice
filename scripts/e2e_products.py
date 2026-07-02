"""Run the 5 product design->firmware->compile scenarios and print a scorecard.

Usage: AIR_E2E_WORKERS=3 python scripts/e2e_products.py
"""
from __future__ import annotations

import os
import sys
import threading
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from firmware_projects import PRODUCTS, run_product  # noqa: E402


def main() -> int:
    workers = int(os.environ.get("AIR_E2E_WORKERS", "3"))
    base = ROOT / "generated" / "e2e_products"
    base.mkdir(parents=True, exist_ok=True)
    scorecard = base / "scorecard.txt"
    lock = threading.Lock()

    def emit(line: str) -> None:
        with lock:
            print(line, flush=True)
            with scorecard.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    scorecard.write_text("=== 5-product design->firmware->compile E2E ===\n", encoding="utf-8")
    print("=== 5-product design->firmware->compile E2E ===", flush=True)

    def run_one(product):
        try:
            return product, run_product(product, base / product.name), None
        except Exception as exc:  # noqa: BLE001
            return product, None, exc

    passed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_one, p) for p in PRODUCTS]
        for future in as_completed(futures):
            product, r, exc = future.result()
            if exc is not None:
                emit(f"[CRASH] {product.name:22} {exc}")
                continue
            passed += 1 if r.ok else 0
            status = "OK  " if r.ok else "FAIL"
            emit(
                f"[{status}] {r.name:22} design_valid={r.design_valid} sim={r.sim_status} "
                f"compiled={r.compiled} iters={r.iterations} "
                f"missing={r.missing_primitives} stub={r.too_short}"
            )
            if not r.ok and r.detail:
                emit(f"        log: {r.detail}")

    emit(f"\nProducts passed: {passed}/{len(PRODUCTS)}")
    return 0 if passed == len(PRODUCTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
