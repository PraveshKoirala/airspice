"""Convergence-aid ladder (issue #45).

The ladder makes what an experienced SPICE user does by hand deterministic and
automatic: run the design as-written first, and only if that does not converge,
escalate the documented ngspice convergence aids in a FIXED order (gmin stepping
-> source stepping -> Gear + one-notch relaxed reltol), recording every attempt.
See docs/convergence_ladder.md for the per-rung ngspice-manual justification.

Why these tests drive the ladder through a programmable fake ``run_ngspice``
rather than a real hard circuit:

  Modern ngspice (46, the local build) self-rescues almost every legitimate
  topology via its built-in transient-op aid (manual section 11.3.5), so forcing
  a *reproducible* rung-1 non-convergence at the netlist level is unreliable and
  version-dependent. The behaviour under test is the LADDER LOGIC — as-written
  first, escalate in order, stop at the first converging rung, mark aids_required
  / terminal, emit SIM-010 on exhaustion — which is a deterministic property of
  the oracle independent of any one ngspice build. We inject the per-rung
  converge/fail decision the same way the existing #55 honesty test injects a
  non-zero exit (tests/test_cli_flow.py), so the pair is hermetic and stable on
  ngspice 42 (CI) and 46 (local) alike. A companion real-ngspice test
  (test_ground_truth.py) proves the rung-1 as-written path is byte-stable for
  already-converging designs.

The known-hard fixture PAIR (issue #45 deliverable 3):
  * ``test_bistable_fails_rung1_passes_rung3`` — a circuit that fails rung 1 and
    converges on rung >= 2 (a stiff switcher / bistable needing an OP nudge):
    aids_required is set, the reported numbers are trusted, and NO repair-worthy
    ASSERT/NGSPICE_FAILED diagnostic is produced (so #19 does not "fix" it).
  * ``test_floating_island_exhausts_ladder`` — a circuit that exhausts the ladder
    (terminal failure): SIM-010 fires with a topology-directed remediation, not
    raw stderr.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest import mock

import pytest

from air.parser import parse_file
from air.simulator import CONVERGENCE_LADDER, NgspiceRun, simulate_analog
import air.simulator as simulator


ROOT = Path(__file__).resolve().parents[1]
# A plain resistive divider with an explicit source: every node has a DC path to
# ground, so the DC-fallback measurement for ``mid`` is well-defined (2.5 V). We
# use it as the carrier design and drive the *convergence decision* via the fake.
ANALOG = ROOT / "examples" / "analog_primitives" / "design.air.xml"
PROFILE = "analog_only"
TEST_ID = "divider_with_load"
PROBE_NET = "mid"


def _rung_programmable_run(converge_on_rung: int | None):
    """Build a fake ``run_ngspice`` that converges only on ``converge_on_rung``.

    The ladder calls ``run_ngspice`` once per rung, in order, reading the probe
    CSVs afterwards to decide convergence. Our fake mirrors that contract: it
    tracks the call index (1-based == rung number, because rung 1 is the first
    call), and on the target rung it writes an ngspice-style ``wrdata`` CSV for
    the probe net so ``_read_ngspice_waveforms_explicit`` finds real data and the
    ladder records that rung as converged. On every other rung it writes nothing
    and returns a non-zero exit — exactly how a rung that did not converge looks
    (no readable transient data). ``converge_on_rung=None`` fails every rung
    (terminal). No dependence on a real ngspice build: the decision is ours.
    """
    state = {"call": 0}

    def fake_run(netlist: Path, log_path: Path, extra_options=None) -> NgspiceRun:
        state["call"] += 1
        rung = state["call"]
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if converge_on_rung is not None and rung == converge_on_rung:
            # Winning rung: emit a two-row wrdata-style CSV (time value) for the
            # probe so the ladder credits a converged transient. 2.5 V matches the
            # divider so the assertion (2.45..2.55 V) passes — a legitimate result
            # that simply needed a numerical nudge.
            wave = netlist.parent.parent / "waveforms" / f"{TEST_ID}_{PROBE_NET}.csv"
            wave.parent.mkdir(parents=True, exist_ok=True)
            wave.write_text(
                " 0.00000000e+00  2.50000000e+00\n 5.00000000e-03  2.50000000e+00\n",
                encoding="utf-8",
            )
            return NgspiceRun(attempted=True, returncode=0, stdout="", stderr="")
        # Non-converging rung: ngspice aborts mid-analysis, no readable data.
        return NgspiceRun(
            attempted=True,
            returncode=1,
            stdout="",
            stderr="Warning: singular matrix: check node mid\nno convergence\n",
        )

    return fake_run


def _simulate_with(fake_run):
    with mock.patch.object(simulator, "run_ngspice", fake_run):
        with tempfile.TemporaryDirectory() as tmp:
            ir, _ = parse_file(ANALOG)
            result = simulate_analog(ir, PROFILE, Path(tmp))
    return result


def _report(result: dict) -> dict:
    return result["reports"][0]


# --------------------------------------------------------------------------- #
# Baseline: as-written converges on rung 1 (parity requirement).
# --------------------------------------------------------------------------- #
def test_as_written_converges_on_rung1_no_aids() -> None:
    """Rung 1 converges -> exactly one attempt, no aids, no note. This is the
    property that keeps an already-converging design's numbers unchanged."""
    result = _simulate_with(_rung_programmable_run(converge_on_rung=1))
    conv = _report(result)["convergence"]
    assert conv["converged"] is True
    assert conv["rung"] == 1
    assert conv["aids_required"] is False
    assert conv["terminal"] is False
    assert conv["note"] is None
    assert len(conv["attempts"]) == 1
    assert conv["attempts"][0]["rung"] == 1
    assert conv["attempts"][0]["options"] == []


# --------------------------------------------------------------------------- #
# Hard fixture A: fails rung 1, converges on rung >= 2.
# --------------------------------------------------------------------------- #
def test_bistable_fails_rung1_passes_rung3() -> None:
    """A stiff switcher / bistable that needs source stepping: fails rung 1 (and
    rung 2), converges on rung 3. The reported numbers are trusted (assertion
    passes), aids_required is set with a note, and critically NO repair-worthy
    diagnostic is emitted — a rung>=2 success must NOT look like a design defect
    to the repair agent (#19)."""
    result = _simulate_with(_rung_programmable_run(converge_on_rung=3))
    report = _report(result)
    conv = report["convergence"]

    assert conv["converged"] is True
    assert conv["rung"] == 3
    assert conv["aids_required"] is True
    assert conv["terminal"] is False
    assert conv["note"] and "numerical aids required" in conv["note"]

    # The ladder tried rungs 1,2 (failed) then 3 (converged) and stopped there —
    # deterministic order, no rung 4.
    tried = [(a["rung"], a["converged"]) for a in conv["attempts"]]
    assert tried == [(1, False), (2, False), (3, True)]
    assert conv["attempts"][2]["options"] == list(CONVERGENCE_LADDER[2].options)

    # Trusted result: backend is real ngspice, the divider assertion passes, and
    # there is NO ASSERT/NGSPICE_FAILED/SIM-010 to trip a repair.
    assert report["backend"] == "ngspice"
    codes = {d["code"] for d in report["diagnostics"]}
    assert "NGSPICE_FAILED" not in codes
    assert "SIM-010" not in codes
    assert "ASSERT_FAILED" not in codes
    assert report["status"] == "passed"


# --------------------------------------------------------------------------- #
# Hard fixture B: exhausts the ladder (terminal failure).
# --------------------------------------------------------------------------- #
def test_floating_island_exhausts_ladder() -> None:
    """A design that survives every numerical aid (e.g. a genuinely floating
    node) exhausts the ladder: terminal failure. SIM-010 fires with a
    topology-directed remediation (check floating nodes / ground path), and the
    convergence section says terminal — the agent inspects topology, not
    values."""
    result = _simulate_with(_rung_programmable_run(converge_on_rung=None))
    report = _report(result)
    conv = report["convergence"]

    assert conv["converged"] is False
    assert conv["terminal"] is True
    assert conv["rung"] is None
    assert conv["aids_required"] is False
    assert conv["note"] and "topology" in conv["note"]
    # Every rung was tried, in order, and all failed.
    assert len(conv["attempts"]) == len(CONVERGENCE_LADDER)
    assert all(a["converged"] is False for a in conv["attempts"])

    # SIM-010 terminal-convergence diagnostic: topology-directed, not raw stderr.
    sim010 = [d for d in report["diagnostics"] if d["code"] == "SIM-010"]
    assert len(sim010) == 1
    assert sim010[0]["severity"] == "error"
    assert "topology" in sim010[0]["message"].lower()
    assert "ground" in " ".join(sim010[0]["suggested_actions"]).lower()
    # Raw ngspice stderr must NOT be the user-facing message (it is preserved for
    # debugging on the co-emitted NGSPICE_FAILED diagnostic instead).
    assert "singular matrix" not in sim010[0]["message"]

    assert report["backend"] == "ngspice_failed"
    assert report["status"] == "failed"


# --------------------------------------------------------------------------- #
# Rung 4 (the only accuracy-relaxing rung) must announce the tolerance change.
# --------------------------------------------------------------------------- #
def test_rung4_note_declares_relaxed_tolerance() -> None:
    """Converging only on rung 4 (Gear + relaxed reltol) must produce a note that
    explicitly says the tolerance was relaxed — silent accuracy loss is the
    failure this issue prevents."""
    result = _simulate_with(_rung_programmable_run(converge_on_rung=4))
    conv = _report(result)["convergence"]
    assert conv["rung"] == 4
    assert conv["aids_required"] is True
    assert "tolerance was relaxed" in conv["note"]


def test_ladder_is_fixed_and_finite() -> None:
    """Guardrail: the ladder is exactly 4 rungs, rung 1 is as-written (no extra
    options), only rung 4 relaxes accuracy, and no rung removes the base deck."""
    assert len(CONVERGENCE_LADDER) == 4
    assert CONVERGENCE_LADDER[0].rung == 1
    assert CONVERGENCE_LADDER[0].options == ()
    relaxing = [r for r in CONVERGENCE_LADDER if r.relaxes]
    assert [r.rung for r in relaxing] == [4]
    # reltol relaxation appears ONLY on rung 4, and exactly one notch (0.005).
    assert any("reltol=0.005" in o for o in CONVERGENCE_LADDER[3].options)
    for rung in CONVERGENCE_LADDER[:3]:
        assert not any("reltol" in o for o in rung.options)
