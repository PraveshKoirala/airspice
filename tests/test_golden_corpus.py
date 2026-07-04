"""Wire the golden-corpus reproducibility gate into the required pytest suite.

The dedicated ``.github/workflows/corpus.yml`` is the primary corpus CI, but the
required ``core-py`` job (ci.yml) runs ``pytest tests/`` with the same apt ngspice.
Adding the check here means the corpus gate rides that required job too.

These tests HARD-RUN when a real ngspice matching the committed pin is reachable
(as in CI), and SKIP otherwise -- a contributor without the pinned ngspice cannot
reproduce version-bearing simulation floats, and must not get a false failure for
it. The determinism guarantee is a CI property; the skip keeps local dev honest
without being obstructive.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
EXPORTER = REPO_ROOT / "scripts" / "export_golden.py"

# Resolve a local AIR_NGSPICE override the same way the CLI/exporter do, so the
# gated tests run locally too. In CI ngspice is on PATH and there is no .env.
try:  # pragma: no cover - environment dependent
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
except ImportError:  # pragma: no cover
    pass


def _load_exporter():
    spec = importlib.util.spec_from_file_location("export_golden", EXPORTER)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _pinned_matches_reachable() -> tuple[bool, str]:
    """Return (ok, reason). ok=True means the reachable ngspice matches the pin."""
    exporter = _load_exporter()
    pinned = exporter.read_pinned_version()
    if pinned is None:
        return False, "no ENGINE_VERSIONS pin committed"
    try:
        detected = exporter.detect_ngspice_version()
    except exporter.ExportError as exc:
        return False, f"ngspice not usable: {exc}"
    if detected != pinned:
        return False, f"ngspice {detected} != pinned {pinned}"
    return True, f"ngspice {detected} matches pin"


_OK, _REASON = _pinned_matches_reachable()
requires_pinned_ngspice = pytest.mark.skipif(not _OK, reason=_REASON)


def _run_exporter(*args: str) -> subprocess.CompletedProcess:
    env = {"PYTHONPATH": str(REPO_ROOT / "packages" / "core" / "src")}
    import os

    full_env = {**os.environ, **env}
    return subprocess.run(
        [sys.executable, str(EXPORTER), *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        env=full_env,
    )


@requires_pinned_ngspice
def test_corpus_check_reproduces():
    """The committed corpus regenerates identically (within the byte/tolerance split)."""
    result = _run_exporter("--check")
    assert result.returncode == 0, f"corpus --check failed:\n{result.stdout}\n{result.stderr}"


@requires_pinned_ngspice
def test_corpus_check_is_deterministic_twice():
    """Two --check runs in a row both pass -- determinism, not luck."""
    for _ in range(2):
        result = _run_exporter("--check")
        assert result.returncode == 0, f"corpus --check failed:\n{result.stdout}\n{result.stderr}"


@requires_pinned_ngspice
def test_corpus_self_test_has_teeth():
    """The mutation self-test proves --check detects a corrupted fixture."""
    result = _run_exporter("--self-test")
    assert result.returncode == 0, f"corpus --self-test failed:\n{result.stdout}\n{result.stderr}"


def test_dump_model_is_deterministic():
    """`air dump-model` produces byte-identical JSON on repeated runs (no ngspice)."""
    import os

    env = {**os.environ, "PYTHONPATH": str(REPO_ROOT / "packages" / "core" / "src")}
    design = REPO_ROOT / "examples" / "esp32_battery_sensor" / "design.air.xml"

    def run() -> str:
        result = subprocess.run(
            [sys.executable, "-m", "air.cli", "dump-model", str(design)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0, result.stderr
        return result.stdout

    first = run()
    second = run()
    assert first == second, "dump-model output is not deterministic across runs"
    assert first.startswith("{") and first.endswith("\n")

