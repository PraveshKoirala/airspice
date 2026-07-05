"""Build-scorer subprocess entry (issue #107).

The #107 build harness is TypeScript (it reuses #19's conversation loop + the #96
gate, which live in ``packages/agent``), but the OBJECTIVE scorer is #106's Python
predicate solver + REAL ngspice sim (``air.build_score``). Rather than fork the
constraint solver + the physics into TS — which would risk divergence from the
code #106 verified against every golden — the harness calls THIS entry as a
subprocess: it writes a JSON request on stdin and reads the score on stdout.

Request  (stdin, JSON):
    { "design_xml": "<system ...>...</system>", "criteria": { ... } }

Response (stdout, JSON):
    { "built": bool, "failed_criterion": str|null, "detail": str,
      "criteria": { "<name>": bool, ... }, "sim_backend": str|null,
      "sim_value": number|null }

The scorer is the SAME code the golden test (``tests/test_build_specs.py``) runs,
so a design that the golden test would accept scores ``built: true`` here. ngspice
is resolved via ``AIR_NGSPICE`` / PATH (``air.tools.ngspice_path``); a
``sim_assertion`` spec run without real ngspice scores a non-build (backend !=
ngspice), never a silent pass.

Run (the harness invokes this; a human can too):
    PYTHONPATH=packages/core/src python -m air.build_score_cli < request.json
"""

from __future__ import annotations

import json
import sys
import traceback

from air.build_score import score_build


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        json.dump({"built": False, "failed_criterion": "request", "detail": f"bad request JSON: {exc}", "criteria": {}}, sys.stdout)
        return 2

    design_xml = request.get("design_xml")
    criteria = request.get("criteria")
    if not isinstance(design_xml, str) or not isinstance(criteria, dict):
        json.dump({"built": False, "failed_criterion": "request", "detail": "request needs design_xml (string) + criteria (object)", "criteria": {}}, sys.stdout)
        return 2

    # NEVER crash the subprocess: an uncaught exception would print a traceback to
    # stderr and leave stdout empty, which the harness would (correctly) surface as
    # a scorer_error. But an exception raised while scoring the AGENT'S design (a
    # pathological topology, an IR shape the predicate solver did not anticipate) is
    # not a broken scorer — it is that specific built design being unscorable, i.e.
    # a NON-build. Catch it and report it as an objective non-build with the reason
    # so it lands in the results table as an honest failure, not lost tooling noise.
    try:
        score = score_build(design_xml, criteria)
        json.dump(score.to_dict(), sys.stdout)
    except Exception as exc:  # noqa: BLE001
        json.dump(
            {
                "built": False,
                "failed_criterion": "scorer_exception",
                "detail": f"{type(exc).__name__}: {exc}",
                "criteria": {},
                "sim_backend": None,
                "sim_value": None,
                "traceback": traceback.format_exc()[-1500:],
            },
            sys.stdout,
        )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
