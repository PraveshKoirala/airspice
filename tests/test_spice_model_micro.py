"""Issue #60 -- per-part MICRO-VERIFICATION on the LOCAL ngspice.

Proves the emitted ``.model 2N2222`` card is not just present but SIMULATES and
makes the transistor behave like a real 2N2222 switch. These are RANGE checks
(version-tolerant, per the PRD), grounded in local ngspice-46 output:

  * driven ON  (base pulled to 5V through 10k) -> collector SATURATES: Vce < 0.3V
    (ngspice-46 measured 0.047V);
  * driven OFF (base at 0V)                     -> collector CUT OFF: Vce > 4.5V
    (ngspice-46 measured 5.0V);
  * a wrong/ABSENT model                        -> ngspice cannot run the netlist
    (removing the .model card yields "could not find a valid modelname").

The ON case FAILS on the pre-fix code: with no ``.model 2N2222`` card in the
netlist ngspice aborts ("could not find a valid modelname") and writes no
waveform, so the saturation assertion has nothing to read.

ngspice is resolved exactly like the CLI/exporter (``AIR_NGSPICE`` then PATH, via
``air.tools.ngspice_path``); the whole module SKIPS when none is reachable, so a
contributor without ngspice gets no false failure.

Run:
    PYTHONPATH=packages/core/src PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
        python -m pytest tests/test_spice_model_micro.py -v
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import pytest

from air.parser import parse_string
from air.spice import compile_spice

REPO_ROOT = Path(__file__).resolve().parent.parent
DESIGN = REPO_ROOT / "tests" / "spice_models" / "bjt_2n2222_switch.air.xml"

# Resolve a local AIR_NGSPICE override from .env the same way test_golden_corpus
# does, so the gated tests run locally too (CI has ngspice on PATH).
try:  # pragma: no cover - environment dependent
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
except ImportError:  # pragma: no cover
    pass

from air.tools import ngspice_path  # noqa: E402

_NGSPICE = ngspice_path()
requires_ngspice = pytest.mark.skipif(_NGSPICE is None, reason="no ngspice reachable (AIR_NGSPICE / PATH)")

# Saturation / cutoff thresholds. The measured values are ~0.047V (ON) and ~5.0V
# (OFF) on ngspice-46; these bounds are wide enough to hold across ngspice builds.
SAT_MAX_V = 0.3
CUTOFF_MIN_V = 4.5


def _compile(design: Path, out: Path) -> str:
    ir, _tree = parse_string(design.read_text(encoding="utf-8"))
    first_test = next(iter(ir.tests.values()), None)
    compile_spice(ir, out, first_test)
    return (out / "spice" / "main.cir").read_text(encoding="utf-8")


def _write_netlist(out: Path, text: str) -> Path:
    spice = out / "spice"
    spice.mkdir(parents=True, exist_ok=True)
    (out / "waveforms").mkdir(parents=True, exist_ok=True)
    netlist = spice / "main.cir"
    netlist.write_text(text, encoding="utf-8", newline="\n")
    return netlist


def _run_ngspice(netlist: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [_NGSPICE, "-b", netlist.name],
        capture_output=True,
        text=True,
        cwd=netlist.parent,
        timeout=120,
    )


def _final_collector_v(out: Path) -> float:
    csv = out / "waveforms" / "switch_on_coll.csv"
    assert csv.exists(), (
        "ngspice wrote no collector waveform -- the transient did not run "
        "(a missing/undefined .model 2N2222 card aborts the simulation)"
    )
    rows = [r for r in csv.read_text(encoding="utf-8").splitlines() if r.strip()]
    assert rows, "collector waveform is empty"
    # wrdata rows are whitespace-separated: `time  v(coll)`; take the last value.
    return float(rows[-1].split()[-1])


@requires_ngspice
def test_2n2222_saturates_when_driven():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        netlist = _compile(DESIGN, out)
        assert ".model 2N2222" in netlist, (
            "the compiled netlist has no real .model 2N2222 card, so ngspice cannot "
            "simulate the design (pre-fix behaviour)"
        )
        run = _run_ngspice(out / "spice" / "main.cir")
        assert run.returncode == 0, (
            f"ngspice failed (rc={run.returncode}):\n{run.stdout}\n{run.stderr}"
        )
        vce = _final_collector_v(out)
        assert vce < SAT_MAX_V, (
            f"driven 2N2222 must SATURATE (Vce < {SAT_MAX_V}V); measured {vce}V"
        )


@requires_ngspice
def test_2n2222_cuts_off_when_not_driven():
    # Same real model, base held at 0V: the transistor must switch OFF (collector
    # near the 5V rail). Proves the card models a real transistor, not a short.
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        netlist = _compile(DESIGN, out)
        off = netlist.replace("V_DRIVE drive 0 DC 5V", "V_DRIVE drive 0 DC 0")
        assert off != netlist, "expected a V_DRIVE source line to retarget to 0V"
        _write_netlist(out, off)
        run = _run_ngspice(out / "spice" / "main.cir")
        assert run.returncode == 0, f"ngspice failed:\n{run.stdout}\n{run.stderr}"
        vce = _final_collector_v(out)
        assert vce > CUTOFF_MIN_V, (
            f"undriven 2N2222 must CUT OFF (Vce > {CUTOFF_MIN_V}V); measured {vce}V"
        )


@requires_ngspice
def test_absent_model_card_fails_ngspice():
    # Control: the model card is load-bearing. Strip it from the compiled netlist
    # (the device line still says 2N2222) and ngspice must NOT produce a valid
    # saturated result -- it aborts on the undefined model.
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        netlist = _compile(DESIGN, out)
        stripped = "\n".join(
            ln for ln in netlist.split("\n") if not ln.startswith(".model 2N2222")
        )
        _write_netlist(out, stripped)
        run = _run_ngspice(out / "spice" / "main.cir")
        wave = out / "waveforms" / "switch_on_coll.csv"
        produced_valid = False
        if run.returncode == 0 and wave.exists():
            rows = [r for r in wave.read_text(encoding="utf-8").splitlines() if r.strip()]
            produced_valid = bool(rows)
        assert not produced_valid, (
            "ngspice must FAIL without the .model 2N2222 card (undefined model), "
            f"but it produced a waveform (rc={run.returncode})"
        )
