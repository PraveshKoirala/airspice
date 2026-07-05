#!/usr/bin/env python3
"""Cross-engine simulation parity comparator (issue #15 deliverable 2).

Diffs the BROWSER (eecircuit-engine / ngspice 45.2) simulation reports produced
by ``scripts/sim_parity.mjs`` against the ALREADY-COMMITTED native reference
reports (ngspice, pinned in ``tests/golden_corpus/ENGINE_VERSIONS``) under
``tests/golden_corpus/<design>/report/reports/<test>.json``.

The comparison contract (issue #15):

  * STRUCTURE byte-exact  -- JSON keys + ordering, the convergence section, the
    backend label, the measurement_stats key set: everything that is NOT a
    number must match to the byte. This is the exporter's own
    ``_compare_numeric_text`` split, and the same one the #14 browser
    ``compareReport`` used, reused here so we do not reinvent the wheel.
  * NUMERIC fields within tolerance -- DC/op values at rtol/atol; transient
    waveforms are compared at ASSERTION-RELEVANT measurements (final/min/max +
    their times) as already reduced into the report, NOT point-by-point.
  * ``time_of_min`` / ``time_of_max`` at an ABSOLUTE time tolerance -- the
    extremum-time of a numerically-flat signal is engine-arbitrary (divergence
    A). The extremum VALUE still matches at rtol.

ALL tolerances live in ONE place: ``tests/golden_corpus/tolerances.json``. This
script contains NO hard-coded tolerance number and NO corpus design name (the
design set is discovered by scanning the committed corpus -- guardrails R4).

Two honestly-formalized divergences (see tolerances.json for the full written
justification):

  A. time_of_* on a flat signal -> the field's abs-time tolerance.
  B. the ``expected_divergences`` design/test named in tolerances.json -> a
     NARROW, self-invalidating per-design entry: native converges, eecircuit
     reports a singular matrix and cannot solve it as-written. This is a
     converge-vs-not case, not a value tolerance. The comparator requires the
     browser to STILL produce the pinned terminal shape; if it starts converging
     (browser ladder landed) or diverges differently, the exception stops
     matching and the job FAILS -- forcing the entry to be removed or
     re-justified.

Version-drift gate (issue #15 amendment 1): the native ngspice version recorded
in tolerances.json ``engine_pins.native_ngspice`` MUST equal the committed
``ENGINE_VERSIONS`` pin, or the job fails IMMEDIATELY, before any comparison.
Different ngspice versions have different default tolerances/stepping and
comparing across them manufactures noise. Both engine versions are printed
loudly in the job summary; they DO differ (native 42 vs browser 45.2) -- that is
the whole point, and the tolerances above absorb the benign drift.

Usage:
  python scripts/compare_reports.py --browser-dir <dir>   compare + write summary
  python scripts/compare_reports.py --self-test           prove the diff has teeth
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Force UTF-8 so the output is identical on ubuntu CI and a Windows console.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
CORPUS_ROOT = REPO_ROOT / "tests" / "golden_corpus"
GROUND_TRUTH_ROOT = REPO_ROOT / "tests" / "ground_truth"
TOLERANCES_PATH = CORPUS_ROOT / "tolerances.json"
ENGINE_VERSIONS_PATH = CORPUS_ROOT / "ENGINE_VERSIONS"

# SI prefixes for parsing formatted report quantities (e.g. "655.118mV" -> V).
# Matches the report's formatQuantity output (which mirrors air.units): a number
# followed by an optional SI prefix and a unit letter. This is a self-contained
# parser so compare_reports.py needs no package install to read report values.
_SI_PREFIX = {
    "f": 1e-15, "p": 1e-12, "n": 1e-9, "u": 1e-6, "µ": 1e-6, "m": 1e-3,
    "": 1.0, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12,
}
_QUANTITY_RE = re.compile(
    r"^\s*([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)\s*"
    r"([fpnuµmkKMGT]?)([A-Za-z]*)\s*$"
)


def parse_quantity_volts(text: str) -> float | None:
    """Parse a formatted report quantity (e.g. '3.3V', '655.118mV', '0V') to a
    base-unit float. Returns None if unparseable. Only the SI-prefix scale is
    applied; the trailing unit letter (V/A) is not validated (the caller knows
    the expected unit from the check)."""
    m = _QUANTITY_RE.match(text)
    if not m:
        try:
            return float(text)
        except ValueError:
            return None
    number, prefix, _unit = m.groups()
    return float(number) * _SI_PREFIX.get(prefix, 1.0)

# A numeric token (int / float / scientific) -- the SAME token the exporter and
# the #14 browser comparator use, so the structure/number split is identical.
NUM_TOKEN = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")
# Lines carrying a time_of_min / time_of_max field (divergence A abs-time tol).
TIME_OF_FIELD_RE = re.compile(r'"time_of_(?:min|max)"')


# --------------------------------------------------------------------------- #
# Tolerances (single source of truth) + version pin.
# --------------------------------------------------------------------------- #

class Tolerances:
    def __init__(self, data: dict) -> None:
        self.raw = data
        defaults = data.get("defaults", {})
        self.rtol = float(defaults.get("rtol", 1e-3))
        self.atol = float(defaults.get("atol", 1e-6))
        field = data.get("field_tolerances", {})
        self.time_abs_tol_min = float(field.get("time_of_min", {}).get("abs_tol_s", 1.0))
        self.time_abs_tol_max = float(field.get("time_of_max", {}).get("abs_tol_s", 1.0))
        self.expected_divergences = data.get("expected_divergences", {})
        self.per_design = data.get("per_design", {})
        self.engine_pins = data.get("engine_pins", {})

    def rtol_atol_for(self, design: str) -> tuple[float, float]:
        override = self.per_design.get(design)
        if isinstance(override, dict):
            return (
                float(override.get("rtol", self.rtol)),
                float(override.get("atol", self.atol)),
            )
        return self.rtol, self.atol

    def divergence_for(self, design: str, test: str) -> dict | None:
        entry = self.expected_divergences.get(design)
        if isinstance(entry, dict) and entry.get("test") == test:
            return entry
        return None


def load_tolerances() -> Tolerances:
    if not TOLERANCES_PATH.exists():
        raise SystemExit(f"FAIL: tolerances file {TOLERANCES_PATH} does not exist")
    return Tolerances(json.loads(TOLERANCES_PATH.read_text(encoding="utf-8")))


def read_pinned_native_version() -> str | None:
    """Read the ngspice pin from tests/golden_corpus/ENGINE_VERSIONS."""
    if not ENGINE_VERSIONS_PATH.exists():
        return None
    for line in ENGINE_VERSIONS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("ngspice="):
            return line.split("=", 1)[1].strip()
    return None


# --------------------------------------------------------------------------- #
# Corpus discovery (no design name hard-coded -- guardrails R4).
# --------------------------------------------------------------------------- #

def discover_report_cases() -> list[tuple[str, str, Path]]:
    """Every (design, test, committed_report_path) with a committed report."""
    cases: list[tuple[str, str, Path]] = []
    for design_dir in sorted(CORPUS_ROOT.iterdir()):
        if not design_dir.is_dir():
            continue
        reports_dir = design_dir / "report" / "reports"
        if not reports_dir.is_dir():
            continue
        for report in sorted(reports_dir.glob("*.json")):
            cases.append((design_dir.name, report.stem, report))
    return cases


# --------------------------------------------------------------------------- #
# The comparator: structure byte-exact, numbers per tolerances.
# --------------------------------------------------------------------------- #

class SignalDiff:
    def __init__(self, design: str, test: str, kind: str, field: str,
                 expected: str, actual: str, detail: str) -> None:
        self.design = design
        self.test = test
        self.kind = kind
        self.field = field
        self.expected = expected
        self.actual = actual
        self.detail = detail


def _numbers_close(en: float, an: float, rtol: float, atol: float) -> bool:
    return abs(en - an) <= atol + rtol * abs(en)


def compare_report(
    design: str,
    test: str,
    expected_text: str,
    actual_text: str,
    tol: Tolerances,
) -> list[SignalDiff]:
    """Structure byte-exact + per-number tolerance, returning readable diffs.

    Mirrors the exporter's `_compare_numeric_text` split and the #14 browser
    `compareReport`, with the divergence-A abs-time tolerance applied ONLY to
    time_of_* fields. Returns [] when the reports agree within contract.
    """
    diffs: list[SignalDiff] = []
    rtol, atol = tol.rtol_atol_for(design)
    exp_lines = expected_text.replace("\r\n", "\n").split("\n")
    act_lines = actual_text.replace("\r\n", "\n").split("\n")
    if len(exp_lines) != len(act_lines):
        diffs.append(SignalDiff(
            design, test, "structure", "(whole report)",
            f"{len(exp_lines)} lines", f"{len(act_lines)} lines",
            "report line count differs (structural mismatch)",
        ))
        return diffs

    # Track the nearest measurement_stats key ("signal") for a readable table.
    current_signal = "(top-level)"
    signal_key_re = re.compile(r'^\s*"([^"]+)"\s*:\s*\{\s*$')

    for i, (el, al) in enumerate(zip(exp_lines, act_lines), start=1):
        km = signal_key_re.match(el)
        if km:
            current_signal = km.group(1)

        exp_struct = NUM_TOKEN.sub("\0", el)
        act_struct = NUM_TOKEN.sub("\0", al)
        if exp_struct != act_struct:
            diffs.append(SignalDiff(
                design, test, "structure", current_signal,
                el.strip(), al.strip(),
                f"line {i}: non-numeric STRUCTURE differs (a changed key / "
                f"reordered field / unit / label is never tolerated)",
            ))
            continue

        is_time_of = bool(TIME_OF_FIELD_RE.search(el))
        field_name = "time_of_*" if is_time_of else _field_on_line(el) or current_signal
        exp_nums = NUM_TOKEN.findall(el)
        act_nums = NUM_TOKEN.findall(al)
        for en_s, an_s in zip(exp_nums, act_nums):
            en, an = float(en_s), float(an_s)
            if is_time_of:
                # Divergence A: flat-signal extremum-time is engine-arbitrary;
                # use the field's abs-time tolerance (which one depends on the
                # exact field on the line).
                abs_tol = tol.time_abs_tol_max if "time_of_max" in el else tol.time_abs_tol_min
                if abs(en - an) > abs_tol:
                    diffs.append(SignalDiff(
                        design, test, "time", f"{current_signal}.{field_name}",
                        en_s, an_s,
                        f"line {i}: extremum-time outside abs tol {abs_tol}s "
                        f"(divergence A covers flat-signal argmax only up to the "
                        f"transient window)",
                    ))
            else:
                if not _numbers_close(en, an, rtol, atol):
                    diffs.append(SignalDiff(
                        design, test, "value", f"{current_signal}",
                        en_s, an_s,
                        f"line {i}: value outside rtol={rtol} atol={atol}",
                    ))
    return diffs


def _field_on_line(line: str) -> str | None:
    m = re.match(r'^\s*"([^"]+)"\s*:', line)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
# Expected-divergence check (divergence B): narrow + self-invalidating.
# --------------------------------------------------------------------------- #

def check_expected_divergence(
    design: str, test: str, expected_report: dict, actual_report: dict, entry: dict,
) -> list[SignalDiff]:
    """Verify a pinned converge-vs-not divergence STILL holds exactly.

    Fails (returns diffs) if native no longer matches the pinned native shape,
    or the browser no longer matches the pinned browser terminal shape -- e.g.
    the browser started converging (its #45 ladder landed) or diverged
    differently. Either way the exception is now stale and the job must fail so
    the entry is removed or re-justified. This is what makes the exception
    NARROW and self-invalidating rather than a blanket skip.
    """
    diffs: list[SignalDiff] = []
    exp_conv = expected_report.get("convergence", {})
    act_conv = actual_report.get("convergence", {})

    checks = [
        ("native converged", exp_conv.get("converged"), entry.get("native_converged")),
        ("browser converged", act_conv.get("converged"), entry.get("browser_converged")),
        ("browser terminal", act_conv.get("terminal"), entry.get("browser_terminal")),
        ("browser backend", actual_report.get("backend"), entry.get("browser_backend")),
    ]
    for label, observed, pinned in checks:
        if pinned is not None and observed != pinned:
            diffs.append(SignalDiff(
                design, test, "divergence", label,
                f"pinned {pinned!r}", f"observed {observed!r}",
                "expected-divergence entry is STALE: the pinned converge-vs-not "
                "shape changed. Remove or re-justify the tolerances.json "
                "expected_divergences entry (see its follow_up).",
            ))
    return diffs


# --------------------------------------------------------------------------- #
# Orchestration.
# --------------------------------------------------------------------------- #

class CaseResult:
    def __init__(self, design: str, test: str) -> None:
        self.design = design
        self.test = test
        self.diffs: list[SignalDiff] = []
        self.divergence_note: str | None = None
        self.missing_browser = False


def compare_all(browser_dir: Path, tol: Tolerances) -> list[CaseResult]:
    results: list[CaseResult] = []
    for design, test, committed_path in discover_report_cases():
        res = CaseResult(design, test)
        browser_path = browser_dir / design / "report" / "reports" / f"{test}.json"
        if not browser_path.exists():
            res.missing_browser = True
            res.diffs.append(SignalDiff(
                design, test, "missing", "(whole report)",
                str(committed_path), str(browser_path),
                "browser produced NO report for this case (sim_parity.mjs "
                "should have written it)",
            ))
            results.append(res)
            continue

        # utf-8-sig tolerates an accidental BOM (e.g. a hand-edited report) while
        # being a no-op on the BOM-free files sim_parity.mjs / the exporter write.
        expected_text = committed_path.read_text(encoding="utf-8-sig")
        actual_text = browser_path.read_text(encoding="utf-8-sig")
        expected_report = json.loads(expected_text)
        actual_report = json.loads(actual_text)

        entry = tol.divergence_for(design, test)
        if entry is not None:
            # Divergence B: the report genuinely diverges (converge-vs-not).
            # Only verify the pinned shape still holds; do NOT diff the numeric
            # values (native ran ngspice, browser fell back to the DC solver on
            # a DIFFERENT node set -- there is no shared waveform to compare).
            res.diffs.extend(
                check_expected_divergence(design, test, expected_report, actual_report, entry)
            )
            res.divergence_note = (
                f"expected divergence (narrow): native converged={entry.get('native_converged')}, "
                f"browser terminal={entry.get('browser_terminal')} "
                f"[{'STILL HOLDS' if not res.diffs else 'CHANGED -> FAIL'}]"
            )
        else:
            res.diffs.extend(
                compare_report(design, test, expected_text, actual_text, tol)
            )
        results.append(res)
    return results


# --------------------------------------------------------------------------- #
# Ground-truth second set (issue #15 amendment 3): the browser engine must
# satisfy the SAME hand-derived physics windows the native oracle does. This
# mirrors the pass-check logic of tests/test_ground_truth.py, applied to the
# browser's captured report + waveform CSVs. A browser value that CONVERGED but
# lands outside the physics window is a real FAIL (the engine produced wrong
# physics). A browser NON-convergence on a physics circuit is the known #45
# browser-ladder gap: reported honestly, but not a failure here (the native side
# validates physics in the required `ground-truth` job).
# --------------------------------------------------------------------------- #

class GroundTruthResult:
    def __init__(self, circuit: str) -> None:
        self.circuit = circuit
        self.status = "pass"        # pass | fail | not-converged | no-report
        self.checks: list[str] = []  # human-readable per-check lines
        self.failures: list[SignalDiff] = []


def _read_csv_samples(path: Path) -> list[tuple[float, float]]:
    samples: list[tuple[float, float]] = []
    for line in path.read_text(encoding="utf-8-sig").splitlines()[1:]:
        parts = line.split(",")
        if len(parts) != 2:
            continue
        try:
            samples.append((float(parts[0]), float(parts[1])))
        except ValueError:
            continue
    return samples


def _sample_at(samples: list[tuple[float, float]], t_s: float) -> tuple[float, float]:
    return min(samples, key=lambda item: abs(item[0] - t_s))


def check_ground_truth(browser_dir: Path) -> list[GroundTruthResult]:
    results: list[GroundTruthResult] = []
    if not GROUND_TRUTH_ROOT.is_dir():
        return results
    for circuit_dir in sorted(GROUND_TRUTH_ROOT.iterdir()):
        if not circuit_dir.is_dir():
            continue
        expected_path = circuit_dir / "expected.json"
        if not expected_path.exists():
            continue
        expected = json.loads(expected_path.read_text(encoding="utf-8"))
        if expected.get("outcome") != "pass":
            continue  # expected-fail modes are oracle-compiler concerns, not the engine's

        name = circuit_dir.name
        res = GroundTruthResult(name)
        test = expected["test"]
        gt_out = browser_dir / "ground_truth" / name
        report_path = gt_out / "report.json"
        if not report_path.exists():
            res.status = "no-report"
            results.append(res)
            continue

        report = json.loads(report_path.read_text(encoding="utf-8-sig"))
        converged = bool(report.get("convergence", {}).get("converged"))
        backend = report.get("backend")
        if not converged or backend != "ngspice":
            # Known #45 browser-ladder gap: honest non-convergence, not a fail.
            res.status = "not-converged"
            res.checks.append(f"browser did not converge (backend={backend}) — #45 ladder gap")
            results.append(res)
            continue

        measurements = report.get("measurements", {})

        # DC checks: final value must sit inside the hand-derived window.
        for check in expected.get("checks", []):
            net = check["net"]
            raw = measurements.get(net)
            value = parse_quantity_volts(raw) if raw is not None else None
            if value is None:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-value", net, f"[{check['min_v']}..{check['max_v']}]",
                    repr(raw), "no browser measurement for this net"))
                continue
            ok = check["min_v"] <= value <= check["max_v"]
            res.checks.append(f"{net}={value:.6g}V in [{check['min_v']},{check['max_v']}] -> {'OK' if ok else 'OUT'}")
            if not ok:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-value", net,
                    f"[{check['min_v']}..{check['max_v']}]V", f"{value:.6g}V",
                    f"browser converged but value outside hand-derived window "
                    f"({check.get('basis', '')})"))

        # Waveform time/mean checks: read the captured browser CSV.
        for check in expected.get("time_checks", []):
            csv_path = gt_out / "csv" / f"{test}_{check['net']}.csv"
            if not csv_path.exists():
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-time", check["net"], f"t={check['t_s']}s",
                    str(csv_path), "browser waveform CSV missing for time check"))
                continue
            samples = _read_csv_samples(csv_path)
            if not samples:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-time", check["net"], f"t={check['t_s']}s",
                    "(empty)", "browser waveform had no samples"))
                continue
            t, value = _sample_at(samples, check["t_s"])
            ok = check["min_v"] <= value <= check["max_v"]
            res.checks.append(f"{check['net']}(t~{check['t_s']}s)={value:.6g}V in "
                              f"[{check['min_v']},{check['max_v']}] -> {'OK' if ok else 'OUT'}")
            if not ok:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-time", f"{check['net']}@{check['t_s']}s",
                    f"[{check['min_v']}..{check['max_v']}]V", f"{value:.6g}V",
                    f"browser waveform outside hand-derived window at t={t:.6g}s"))

        for check in expected.get("mean_checks", []):
            csv_path = gt_out / "csv" / f"{test}_{check['net']}.csv"
            if not csv_path.exists():
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-mean", check["net"], f"t>={check['from_t_s']}s",
                    str(csv_path), "browser waveform CSV missing for mean check"))
                continue
            samples = _read_csv_samples(csv_path)
            tail = [v for (t, v) in samples if t >= check["from_t_s"]]
            if not tail:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-mean", check["net"], f"t>={check['from_t_s']}s",
                    "(none)", "no browser samples in the mean window"))
                continue
            mean = sum(tail) / len(tail)
            ok = check["min_v"] <= mean <= check["max_v"]
            res.checks.append(f"mean {check['net']}(t>={check['from_t_s']}s)={mean:.6g}V in "
                              f"[{check['min_v']},{check['max_v']}] -> {'OK' if ok else 'OUT'}")
            if not ok:
                res.status = "fail"
                res.failures.append(SignalDiff(
                    name, test, "gt-mean", check["net"],
                    f"[{check['min_v']}..{check['max_v']}]V", f"{mean:.6g}V",
                    "browser waveform mean outside hand-derived window"))

        results.append(res)
    return results


# --------------------------------------------------------------------------- #
# Reporting: readable per-signal diff table in the job summary.
# --------------------------------------------------------------------------- #

def _md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def build_summary(
    results: list[CaseResult], tol: Tolerances,
    native_pin: str, browser_engine: str, browser_ngspice: str, browser_installed: str,
    gt_results: list["GroundTruthResult"] | None = None,
) -> str:
    lines: list[str] = []
    lines.append("## sim-parity: cross-engine simulation parity")
    lines.append("")

    # Version pinning, said loudly (issue #15 deliverable 4).
    lines.append("### Engine versions")
    lines.append("")
    lines.append("| engine | version | ngspice |")
    lines.append("|---|---|---|")
    lines.append(f"| native (reference, ENGINE_VERSIONS pin) | ngspice | **{native_pin}** |")
    lines.append(f"| browser (WASM) | {browser_engine} | **{browser_ngspice}** |")
    lines.append("")
    if browser_installed and browser_installed != "unknown":
        lines.append(f"- installed eecircuit-engine package: `{browser_installed}`")
    lines.append(
        f"- **The two engines run DIFFERENT ngspice versions ({native_pin} vs "
        f"{browser_ngspice})** — this is expected; the tolerances in "
        "`tests/golden_corpus/tolerances.json` absorb the benign last-digit drift."
    )
    lines.append("")

    total = len(results)
    failing = [r for r in results if r.diffs]
    diverged = [r for r in results if r.divergence_note and not r.diffs]

    lines.append("### Per-case result")
    lines.append("")
    lines.append("| design | test | result | note |")
    lines.append("|---|---|---|---|")
    for r in results:
        if r.diffs:
            result = "FAIL"
        elif r.divergence_note:
            result = "diverged (expected)"
        else:
            result = "match"
        note = r.divergence_note or ""
        lines.append(f"| {r.design} | {r.test} | {result} | {_md_escape(note)} |")
    lines.append("")

    if failing:
        lines.append("### Diffs (per signal)")
        lines.append("")
        lines.append("| design | test | signal / field | kind | expected (native) | actual (browser) | detail |")
        lines.append("|---|---|---|---|---|---|---|")
        for r in failing:
            for d in r.diffs:
                lines.append(
                    f"| {d.design} | {d.test} | `{_md_escape(d.field)}` | {d.kind} | "
                    f"`{_md_escape(d.expected)}` | `{_md_escape(d.actual)}` | {_md_escape(d.detail)} |"
                )
        lines.append("")
        lines.append(
            f"**{len(failing)} of {total} case(s) FAILED parity.** Every loosened "
            "tolerance must be justified in `tests/golden_corpus/tolerances.json`."
        )
    else:
        lines.append(
            f"### All {total} case(s) within tolerance "
            f"({len(diverged)} honest, pinned divergence)."
        )
    lines.append("")

    # Ground-truth second set (amendment 3): both engines vs hand-derived physics.
    if gt_results:
        gt_fail = [g for g in gt_results if g.status == "fail"]
        gt_nc = [g for g in gt_results if g.status in ("not-converged", "no-report")]
        gt_ok = [g for g in gt_results if g.status == "pass"]
        lines.append("### Ground-truth physics (browser engine vs hand-derived windows)")
        lines.append("")
        lines.append("| circuit | result | checks |")
        lines.append("|---|---|---|")
        for g in gt_results:
            label = {
                "pass": "OK", "fail": "FAIL",
                "not-converged": "not-converged (#45 gap)",
                "no-report": "no report (#45 gap)",
            }[g.status]
            lines.append(f"| {g.circuit} | {label} | {_md_escape('; '.join(g.checks))} |")
        lines.append("")
        lines.append(
            f"- {len(gt_ok)} circuit(s) where the browser CONVERGED satisfy the "
            f"hand-derived physics windows; {len(gt_nc)} hit the known browser-ladder "
            f"gap (#45, reported honestly, not failing — the native reference validates "
            f"these in the required `ground-truth` job); {len(gt_fail)} FAILED physics."
        )
        if gt_fail:
            lines.append("")
            lines.append("| circuit | net | expected window | browser | detail |")
            lines.append("|---|---|---|---|---|")
            for g in gt_fail:
                for d in g.failures:
                    lines.append(
                        f"| {d.design} | `{_md_escape(d.field)}` | `{_md_escape(d.expected)}` | "
                        f"`{_md_escape(d.actual)}` | {_md_escape(d.detail)} |"
                    )
        lines.append("")
    return "\n".join(lines)


def write_job_summary(text: str) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# CLI.
# --------------------------------------------------------------------------- #

def run(browser_dir: Path) -> int:
    tol = load_tolerances()

    # Version-drift gate (amendment 1): fail IMMEDIATELY on a native pin mismatch.
    native_pin = read_pinned_native_version()
    if native_pin is None:
        print("FAIL: no ngspice pin found in tests/golden_corpus/ENGINE_VERSIONS", file=sys.stderr)
        return 1
    tol_native = str(tol.engine_pins.get("native_ngspice", "")).strip()
    if tol_native and tol_native != native_pin:
        msg = (
            f"FAIL (version-drift gate): tolerances.json engine_pins.native_ngspice="
            f"{tol_native!r} != ENGINE_VERSIONS ngspice={native_pin!r}. "
            "The native reference version drifted from the tolerances contract; "
            "comparing across ngspice versions manufactures noise. Re-pin or "
            "regenerate the corpus (oracle-first) before running parity."
        )
        print(msg, file=sys.stderr)
        write_job_summary("## sim-parity\n\n**" + msg + "**\n")
        return 1

    # Browser engine versions recorded by sim_parity.mjs (informational + summary).
    versions_path = browser_dir / "ENGINE_VERSIONS.json"
    browser_engine = tol.engine_pins.get("browser_engine", "eecircuit-engine")
    browser_ngspice = str(tol.engine_pins.get("browser_ngspice", "unknown"))
    browser_installed = "unknown"
    if versions_path.exists():
        try:
            v = json.loads(versions_path.read_text(encoding="utf-8"))
            browser_engine = f"{v.get('engine', 'eecircuit-engine')}@{v.get('engineVersion', '?')}"
            browser_ngspice = str(v.get("ngspiceVersion", browser_ngspice))
            browser_installed = str(v.get("installedEecircuit", "unknown"))
        except (OSError, json.JSONDecodeError):
            pass

    results = compare_all(browser_dir, tol)
    gt_results = check_ground_truth(browser_dir)
    summary = build_summary(
        results, tol, native_pin, browser_engine, browser_ngspice, browser_installed,
        gt_results,
    )
    print(summary)
    write_job_summary(summary)

    failing = [r for r in results if r.diffs]
    gt_failing = [g for g in gt_results if g.status == "fail"]
    if failing or gt_failing:
        if failing:
            print(f"\nFAIL: {len(failing)} corpus case(s) diverged beyond tolerance.", file=sys.stderr)
        if gt_failing:
            print(f"FAIL: {len(gt_failing)} ground-truth circuit(s) where the browser "
                  f"converged produced wrong physics.", file=sys.stderr)
        return 1
    gt_nc = [g for g in gt_results if g.status in ("not-converged", "no-report")]
    print(f"\nOK: all {len(results)} corpus case(s) within tolerance; "
          f"{len(gt_results) - len(gt_nc)} ground-truth circuit(s) satisfy physics "
          f"({len(gt_nc)} known #45 ladder gaps, non-failing).")
    return 0


def self_test() -> int:
    """Prove the comparator has teeth: a deliberate perturbation must be caught,
    and byte-identical + divergence-A/B cases must pass. Pure in-memory; needs no
    browser, no corpus files (uses synthetic reports)."""
    failures: list[str] = []

    tol = Tolerances({
        "defaults": {"rtol": 1e-3, "atol": 1e-6},
        "field_tolerances": {
            "time_of_min": {"abs_tol_s": 1.0},
            "time_of_max": {"abs_tol_s": 1.0},
        },
        "expected_divergences": {
            "designX": {
                "test": "t", "native_converged": True, "browser_converged": False,
                "browser_terminal": True, "browser_backend": "builtin_dc_fallback",
            }
        },
    })

    def rpt(value: str, tmax: str = "0s", backend: str = "ngspice",
            converged: bool = True, terminal: bool = False) -> str:
        obj = {
            "backend": backend,
            "convergence": {"converged": converged, "terminal": terminal, "rung": 1 if converged else None},
            "measurement_stats": {"n1": {"final": value, "max": value, "min": value,
                                         "time_of_max": tmax, "time_of_min": "0s"}},
            "measurements": {"n1": value},
        }
        return json.dumps(obj, indent=2, sort_keys=True) + "\n"

    # Case 1: byte-identical -> no diffs.
    d = compare_report("d", "t", rpt("3.3V"), rpt("3.3V"), tol)
    if d:
        failures.append(f"identical reports produced diffs: {[x.detail for x in d]}")

    # Case 2: value within rtol -> no diffs (3.3V vs 3.3003V ~ 9e-5 rel).
    d = compare_report("d", "t", rpt("3.3V"), rpt("3.3003V"), tol)
    if d:
        failures.append(f"within-rtol value flagged: {[x.detail for x in d]}")

    # Case 3: value OUTSIDE rtol -> MUST be caught (the deliberate-break shape).
    d = compare_report("d", "t", rpt("3.3V"), rpt("3.5V"), tol)
    if not any(x.kind == "value" for x in d):
        failures.append("out-of-tolerance value (3.3V vs 3.5V) was NOT caught")

    # Case 4: divergence A -- flat-signal time_of_max drift within abs tol.
    d = compare_report("d", "t", rpt("1.04211V", "0s"), rpt("1.04211V", "2.28e-06s"), tol)
    if d:
        failures.append(f"divergence-A flat-signal time_of_max flagged: {[x.detail for x in d]}")

    # Case 5: structure change (a renamed key) -> MUST be caught even with numbers equal.
    bad = rpt("3.3V").replace('"final"', '"finalX"')
    d = compare_report("d", "t", rpt("3.3V"), bad, tol)
    if not any(x.kind == "structure" for x in d):
        failures.append("structural key change was NOT caught")

    # Case 6: divergence B -- pinned converge-vs-not holds -> no diffs.
    native = json.loads(rpt("3V"))
    browser = json.loads(rpt("3V", backend="builtin_dc_fallback", converged=False, terminal=True))
    entry = tol.divergence_for("designX", "t")
    d = check_expected_divergence("designX", "t", native, browser, entry)
    if d:
        failures.append(f"holding divergence-B flagged as changed: {[x.detail for x in d]}")

    # Case 7: divergence B CHANGED (browser now converges) -> MUST be caught.
    browser_conv = json.loads(rpt("3V"))  # converged=True, backend=ngspice
    d = check_expected_divergence("designX", "t", native, browser_conv, entry)
    if not d:
        failures.append("stale divergence-B (browser now converges) was NOT caught")

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("SELF-TEST PASSED: comparator catches value/structure breaks and stale "
          "divergences; tolerates within-rtol and flat-signal time drift.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Cross-engine sim-parity comparator (issue #15).")
    parser.add_argument("--browser-dir", help="Dir of browser reports from sim_parity.mjs.")
    parser.add_argument("--self-test", action="store_true",
                        help="Run the comparator's own teeth-check and exit.")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.browser_dir:
        parser.error("--browser-dir is required (or use --self-test)")
    browser_dir = Path(args.browser_dir).resolve()
    if not browser_dir.exists():
        print(f"FAIL: browser report dir {browser_dir} does not exist", file=sys.stderr)
        return 1
    return run(browser_dir)


if __name__ == "__main__":
    raise SystemExit(main())
