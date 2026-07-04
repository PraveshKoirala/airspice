"""Oracle ground-truth validation (issue #41).

This runner is the INDEPENDENT AUDIT of the Python oracle. Every expected value
it asserts is hand-derived in the sibling ``derivation.md`` and pinned in
``expected.json`` — nothing here is copied from a simulator run. Parity testing
(the golden corpus) proves every port matches the oracle; this proves the oracle
matches physics.

Each circuit lives in ``tests/ground_truth/<name>/`` with three files:

* ``design.air.xml``  — the design
* ``derivation.md``   — the hand-worked math / datasheet citation
* ``expected.json``   — machine-readable expectations + physics tolerances

``expected.json`` schema
------------------------
Common keys::

    circuit, profile, test           identifiers
    outcome                          "pass" | "expected_fail"
    require_backend                  (pass only) the backend that MUST have run,
                                     e.g. "ngspice"; a fallback result is a hard
                                     failure — it is NOT ground-truth evidence.

For ``outcome == "pass"`` one or more of::

    checks:      [{net, min_v, max_v, ...}]           final/DC value per net
    time_checks: [{net, t_s, min_v, max_v, ...}]      waveform sample at a time
    mean_checks: [{net, from_t_s, min_v, max_v, ...}] mean of waveform tail

For ``outcome == "expected_fail"``::

    failure_mode:  "undefined_model"  (bug #55: ngspice cannot run the netlist,
                                        oracle downgrades to builtin_dc_fallback)
                   "no_ac_analysis"   (compiler emits only .tran, so a
                                        frequency-domain check is unverifiable)
                   "wrong_stimulus"   (ngspice runs, but the compiler emits a
                                        physically wrong stimulus, e.g. the PWM
                                        duty-cycle defect #59)
    issue:         the linked issue (55 for the #55-class, 59 for the PWM defect,
                   or another gap issue)
    would_pass_checks / dc_settle_check / oracle_actual_window
                   documentation of the true physics and, for the run-but-wrong
                   modes, the (defective) value the oracle actually produces.

Hard-fail policy
----------------
* If ngspice is not resolvable at all, every test ERRORS (never silently green).
* A ``pass`` circuit whose report says ``builtin_dc_fallback`` FAILS loudly — a
  fallback number is not evidence the physics was checked.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from air.parser import parse_file
from air.simulator import simulate_analog, _read_samples
from air.tools import ngspice_path
from air.units import parse_quantity
from air.validation import has_errors, validate_ir, validate_tree


GROUND_TRUTH_DIR = Path(__file__).resolve().parent / "ground_truth"


def _circuit_dirs() -> list[Path]:
    return sorted(p for p in GROUND_TRUTH_DIR.iterdir() if p.is_dir() and (p / "expected.json").exists())


CIRCUIT_IDS = [p.name for p in _circuit_dirs()]


def _load_expected(circuit_dir: Path) -> dict:
    return json.loads((circuit_dir / "expected.json").read_text(encoding="utf-8"))


def _report_for(result: dict, test_id: str) -> dict:
    for report in result["reports"]:
        if report["test"] == test_id:
            return report
    raise AssertionError(f"No report produced for test {test_id!r}; got {[r['test'] for r in result['reports']]}")


def _measured_v(report: dict, net: str) -> float:
    """Final/DC value of a net from the report's measurements (parsed to volts)."""
    raw = report["measurements"].get(net)
    assert raw is not None, f"net {net!r} not in report measurements {list(report['measurements'])}"
    return parse_quantity(raw, "V")


def _waveform_samples(out_dir: Path, test_id: str, net: str) -> list[tuple[float, float]]:
    path = out_dir / "waveforms" / f"{test_id}_{net}.csv"
    assert path.exists(), f"expected waveform {path} was not written"
    samples = _read_samples(path)
    assert samples, f"waveform {path} had no numeric samples"
    return samples


def _sample_at(samples: list[tuple[float, float]], t_s: float) -> tuple[float, float]:
    return min(samples, key=lambda item: abs(item[0] - t_s))


# ---------------------------------------------------------------------------
# ngspice must actually be present; otherwise the whole suite errors loudly.
# ---------------------------------------------------------------------------

def test_ngspice_is_available() -> None:
    path = ngspice_path()
    assert path, (
        "ngspice is not resolvable (AIR_NGSPICE env or PATH). Ground-truth "
        "validation requires REAL ngspice; a missing simulator must fail the "
        "suite, never pass silently."
    )


@pytest.fixture(scope="module")
def require_ngspice() -> str:
    path = ngspice_path()
    if not path:
        pytest.fail("ngspice not available; ground-truth validation cannot run without real ngspice.")
    return path


@pytest.mark.parametrize("circuit_dir", _circuit_dirs(), ids=CIRCUIT_IDS)
def test_ground_truth_circuit(circuit_dir: Path, require_ngspice: str, tmp_path: Path) -> None:
    expected = _load_expected(circuit_dir)
    design = circuit_dir / "design.air.xml"
    ir, tree = parse_file(design)

    # The design must be schema/semantically valid (no shortcuts hiding errors).
    diagnostics = validate_tree(tree) + validate_ir(ir)
    assert not has_errors(diagnostics), (
        f"{circuit_dir.name}: design has validation errors: "
        f"{[d.code for d in diagnostics if d.severity == 'error']}"
    )

    out_dir = tmp_path / circuit_dir.name
    result = simulate_analog(ir, expected["profile"], out_dir)
    report = _report_for(result, expected["test"])
    backend = report["backend"]

    outcome = expected["outcome"]
    if outcome == "pass":
        _assert_pass(circuit_dir.name, expected, report, backend, out_dir)
    elif outcome == "expected_fail":
        _assert_expected_fail(circuit_dir.name, expected, report, backend, out_dir)
    else:
        raise AssertionError(f"{circuit_dir.name}: unknown outcome {outcome!r}")


def _assert_pass(name: str, expected: dict, report: dict, backend: str, out_dir: Path) -> None:
    required_backend = expected.get("require_backend", "ngspice")
    # HARD FAIL on fallback: a builtin_dc_fallback report is not ground-truth
    # evidence — it means ngspice never actually simulated the circuit (#55).
    assert backend == required_backend, (
        f"{name}: expected real backend {required_backend!r} but report says "
        f"{backend!r}. A fallback/downgraded result cannot validate physics "
        f"(see issue #55)."
    )

    for check in expected.get("checks", []):
        net = check["net"]
        value = _measured_v(report, net)
        assert check["min_v"] <= value <= check["max_v"], (
            f"{name}: {net} = {value:.6g} V outside hand-derived window "
            f"[{check['min_v']}, {check['max_v']}] V. Basis: {check.get('basis')}"
        )

    for check in expected.get("time_checks", []):
        samples = _waveform_samples(out_dir, expected["test"], check["net"])
        t, value = _sample_at(samples, check["t_s"])
        assert check["min_v"] <= value <= check["max_v"], (
            f"{name}: {check['net']}(t={t:.6g}s, target {check['t_s']}s) = "
            f"{value:.6g} V outside window [{check['min_v']}, {check['max_v']}] V. "
            f"Basis: {check.get('basis')}"
        )

    for check in expected.get("mean_checks", []):
        samples = _waveform_samples(out_dir, expected["test"], check["net"])
        tail = [v for (t, v) in samples if t >= check["from_t_s"]]
        assert tail, f"{name}: no samples after t={check['from_t_s']}s for mean check"
        mean = sum(tail) / len(tail)
        assert check["min_v"] <= mean <= check["max_v"], (
            f"{name}: mean {check['net']} (t>={check['from_t_s']}s) = {mean:.6g} V "
            f"outside window [{check['min_v']}, {check['max_v']}] V. "
            f"Basis: {check.get('basis')}"
        )


def _assert_expected_fail(name: str, expected: dict, report: dict, backend: str, out_dir: Path) -> None:
    mode = expected["failure_mode"]
    issue = expected.get("issue")

    if mode == "undefined_model":
        # Bug #55: the netlist references an undefined model/subckt, so real
        # ngspice cannot run it and the oracle downgrades to the DC fallback.
        # The AUDIT finding is precisely that the oracle produces NO real result
        # here — so we assert the backend is NOT the real one. If a future fix
        # makes ngspice actually simulate this, the assertion below flips and the
        # 'would_pass_checks' window becomes the acceptance test.
        assert backend != "ngspice", (
            f"{name}: expected the oracle to FAIL to run this circuit with real "
            f"ngspice (undefined model, issue #{issue}), but it reported "
            f"backend={backend!r}. If #{issue} is fixed, convert this circuit to "
            f"outcome=pass using its would_pass_checks window."
        )
    elif mode == "no_ac_analysis":
        # The compiler emits only .tran with a DC source, so the circuit DC-settles
        # instead of showing a frequency response. ngspice DOES run (backend real),
        # but the frequency-domain answer is absent. We confirm both: it settles to
        # the DC value, and it does NOT land in the (would-be) -3dB window.
        assert backend == "ngspice", (
            f"{name}: expected real ngspice to run (all components emittable) but "
            f"got backend={backend!r}."
        )
        dc = expected["dc_settle_check"]
        value = _measured_v(report, dc["net"])
        assert dc["min_v"] <= value <= dc["max_v"], (
            f"{name}: DC settle {dc['net']} = {value:.6g} V outside expected "
            f"[{dc['min_v']}, {dc['max_v']}] V — the oracle's actual (DC) behaviour. "
            f"Basis: {dc.get('basis')}"
        )
        # Prove the frequency-domain answer is genuinely absent: the DC settle must
        # NOT coincide with the -3dB target window.
        for wpc in expected.get("would_pass_checks", []):
            if wpc["net"] != dc["net"]:
                continue
            in_ac_window = wpc["min_v"] <= value <= wpc["max_v"]
            assert not in_ac_window, (
                f"{name}: DC-settled value {value:.6g} V unexpectedly fell inside the "
                f"AC (-3dB) window [{wpc['min_v']}, {wpc['max_v']}] V — investigate; the "
                f"expected-failure premise (no frequency response) no longer holds."
            )
    elif mode == "wrong_stimulus":
        # ngspice runs fine, but the compiler emitted a physically wrong stimulus
        # (e.g. the PWM duty defect #59). We confirm (a) ngspice really ran,
        # (b) the settled mean matches the oracle's ACTUAL (defective) value —
        # documenting the bug precisely — and (c) it does NOT match the correct
        # physics window. When the bug is fixed the mean moves into the correct
        # window and this case should flip to outcome=pass.
        assert backend == "ngspice", (
            f"{name}: expected real ngspice to run but got backend={backend!r}."
        )
        net = expected["mean_net"]
        from_t = expected["from_t_s"]
        samples = _waveform_samples(out_dir, expected["test"], net)
        tail = [v for (t, v) in samples if t >= from_t]
        assert tail, f"{name}: no samples after t={from_t}s for mean check"
        mean = sum(tail) / len(tail)

        actual = expected["oracle_actual_window"]
        assert actual["min_v"] <= mean <= actual["max_v"], (
            f"{name}: oracle mean {net} = {mean:.6g} V is no longer in the "
            f"documented DEFECTIVE window [{actual['min_v']}, {actual['max_v']}] V "
            f"(bug #{issue}). If the mean has moved, the defect behaviour changed — "
            f"re-derive and, if it now matches the correct window, flip this circuit "
            f"to outcome=pass. Basis: {actual.get('basis')}"
        )
        for wpc in expected.get("would_pass_checks", []):
            if wpc["net"] != net:
                continue
            in_correct_window = wpc["min_v"] <= mean <= wpc["max_v"]
            assert not in_correct_window, (
                f"{name}: oracle mean {mean:.6g} V unexpectedly fell inside the "
                f"CORRECT physics window [{wpc['min_v']}, {wpc['max_v']}] V — bug "
                f"#{issue} may be fixed; flip this circuit to outcome=pass."
            )
    else:
        raise AssertionError(f"{name}: unknown failure_mode {mode!r}")
