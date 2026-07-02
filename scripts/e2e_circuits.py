"""Run the 20-circuit multi-step agent gauntlet live and print a scorecard.

Usage:  python scripts/e2e_circuits.py [provider]   (default provider: gemini)
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

from circuit_scenarios import SCENARIOS, run_scenario  # noqa: E402


def main() -> int:
    provider = sys.argv[1] if len(sys.argv) > 1 else "gemini"
    workers = int(os.environ.get("AIR_E2E_WORKERS", "6"))
    base = ROOT / "generated" / "e2e_circuits"
    base.mkdir(parents=True, exist_ok=True)
    scorecard = base / "scorecard.txt"
    total = passed = 0
    failed_steps: list[str] = []
    lock = threading.Lock()

    def emit(line: str) -> None:
        with lock:
            print(line, flush=True)
            with scorecard.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")

    header = f"=== 20-circuit multi-step E2E (provider={provider}, workers={workers}) ==="
    scorecard.write_text(header + "\n", encoding="utf-8")
    print(header, flush=True)

    def run_one(scenario):
        try:
            return scenario, run_scenario(scenario, base / scenario.name, provider=provider), None
        except Exception as exc:  # scenario-level isolation
            return scenario, None, exc

    # Scenarios are independent; run them concurrently (agent calls are I/O-bound).
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(run_one, sc) for sc in SCENARIOS]
        for future in as_completed(futures):
            scenario, results, exc = future.result()
            if exc is not None:
                emit(f"[CRASH] {scenario.name:24} {exc}")
                continue
            marks = []
            for index, r in enumerate(results):
                total += 1
                tag = {"draw": "D", "minor": "m", "major": "M"}[r.kind]
                if r.ok:
                    passed += 1
                    marks.append(tag + "+")
                else:
                    marks.append(tag + "!")
                    failed_steps.append(
                        f"  {scenario.name}[{index}/{r.kind}]: valid={r.valid} codes={r.error_codes} "
                        f"sim={r.sim_status} num={r.numeric_ok} mode={getattr(r, 'detail', '')}".rstrip()
                    )
            status = "OK " if all(r.ok for r in results) else "FAIL"
            emit(f"[{status}] {scenario.name:24} {' '.join(marks)}")

    emit(f"\nSteps passed: {passed}/{total}")
    if failed_steps:
        emit("\nFailures:\n" + "\n".join(failed_steps))
    return 0 if passed == total and total > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
