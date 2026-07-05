"""Build-loop simulation subprocess entry (issue #107).

In LIVE mode the build harness lets the AGENT call ``run_simulation`` while it
builds, so it can tune analog values (e.g. a divider ratio) against REAL physics
before finalizing. The harness is TypeScript but the simulator is Python
(``air.simulator.simulate_analog`` on real ngspice), so — like the scorer — the
build engine invokes THIS entry as a subprocess: it writes ``{design_xml}`` on
stdin and reads a #14-shaped simulation report on stdout.

This is used ONLY for the agent's own iterative feedback during a live build. The
OBJECTIVE scoring sim is separate (``air.build_score_cli``); a build passes or
fails on the scorer's real-ngspice ``sim_assertion``, not on anything the agent's
run_simulation returned. In mock/CI mode the harness uses a deterministic sim stub
instead of this entry (no ngspice, no network).

Request  (stdin, JSON):  { "design_xml": "<system ...>...</system>" }
Response (stdout, JSON):  a SimulationReportLike:
    { "profile", "status", "reports": [ { "test", "profile", "status",
      "backend", "convergence", "measurements", "diagnostics" } ], "notes",
      "runId" }

Run:
    PYTHONPATH=packages/core/src python -m air.build_sim_cli < request.json
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from air.parser import parse_string
from air.simulator import simulate_analog


def _empty_report(status: str, note: str) -> dict:
    return {
        "profile": "analog_only",
        "status": status,
        "reports": [],
        "notes": [note] if note else [],
        "runId": "build-sim",
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        json.dump(_empty_report("failed", f"bad request JSON: {exc}"), sys.stdout)
        return 2

    design_xml = request.get("design_xml")
    if not isinstance(design_xml, str):
        json.dump(_empty_report("failed", "request needs design_xml (string)"), sys.stdout)
        return 2

    try:
        ir, _tree = parse_string(design_xml)
    except Exception as exc:  # noqa: BLE001
        json.dump(_empty_report("failed", f"design did not parse: {exc}"), sys.stdout)
        return 0

    out_dir = Path(tempfile.mkdtemp(prefix="build_sim_"))
    try:
        result = simulate_analog(ir, "analog_only", out_dir)
    except Exception as exc:  # noqa: BLE001
        json.dump(_empty_report("failed", f"simulation failed: {exc}"), sys.stdout)
        return 0

    # simulate_analog returns { success, profile, status, reports:[{...}] }; the
    # report entries already carry the fields the TS SimulationReportLike reads
    # (test/profile/status/backend/convergence/measurements/diagnostics).
    response = {
        "profile": result.get("profile", "analog_only"),
        "status": result.get("status", "failed"),
        "reports": result.get("reports", []),
        "notes": [],
        "runId": "build-sim",
    }
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
