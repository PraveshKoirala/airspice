#!/usr/bin/env python
"""Freeze reference outputs of the Python oracle into ``tests/golden_corpus/``.

This is the keystone of the AirSpice roadmap: every future TypeScript/WASM port
of the engine is verified against the fixtures this script produces. The whole
point is determinism, so the generator kills nondeterminism at the source rather
than fuzzing it away at compare time.

Usage
-----
    python scripts/export_golden.py              # regenerate the committed corpus
    python scripts/export_golden.py --check      # verify the corpus is reproducible
    python scripts/export_golden.py --self-test  # prove --check has teeth (mutation test)

Per-design artifacts (see issue #4)
-----------------------------------
    <design>/input.air.xml       verbatim source copy
    <design>/canonical.air.xml   canonicalizer output
    <design>/model.json          deterministic typed-model dump (air.model_dump)
    <design>/diagnostics.json    full validation diagnostics
    <design>/netlist.cir         SPICE compiler output (valid designs only)
    <design>/graph.json          graph / SchematicIR compiler output
    <design>/report/             ngspice reports + waveform CSVs (valid + ngspice profile)

The byte-exact vs tolerance split in ``--check`` (orchestrator contract on issue #4)
------------------------------------------------------------------------------------
Deterministic artifacts -- ``input.air.xml``, ``canonical.air.xml``, ``model.json``,
``diagnostics.json``, ``netlist.cir``, ``graph.json``, and ``report/**/probes.json``
-- are compared BYTE-FOR-BYTE. Simulation float payloads under ``report/`` (report
JSON numeric fields and waveform CSVs) are compared with a numeric tolerance
(rtol=1e-6, atol=1e-12) because float noise across platforms / ngspice builds makes
byte-exactness unachievable there; the report *structure* (JSON keys and ordering,
CSV header and row count) is still byte-exact.

The ngspice version gate (post-audit amendment, binding)
--------------------------------------------------------
``simulator.py`` silently falls back to a deterministic DC approximation when
ngspice is missing. A contributor without ngspice would then regenerate DIFFERENT
fixtures with no error. So before writing (or checking) anything, this script
verifies a real ngspice binary is reachable AND its version matches the pin in
``tests/golden_corpus/ENGINE_VERSIONS``, aborting loudly otherwise. On a fresh
generate (when no pin exists yet) the detected version is written as the pin.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.etree import ElementTree as ET

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "packages" / "core" / "src"
sys.path.insert(0, str(SRC_ROOT))

from air.canonicalizer import canonicalize_tree  # noqa: E402
from air.graph import build_graph_data  # noqa: E402
from air.model_dump import model_to_dict  # noqa: E402
from air.parser import parse_file  # noqa: E402
from air.simulator import simulate_analog  # noqa: E402
from air.spice import compile_spice  # noqa: E402
from air.tools import ngspice_path  # noqa: E402
from air.validation import has_errors, validate_ir, validate_tree  # noqa: E402

CORPUS_DIR = REPO_ROOT / "tests" / "golden_corpus"
ENGINE_VERSIONS_PATH = CORPUS_DIR / "ENGINE_VERSIONS"

# Non-fixture files that live UNDER tests/golden_corpus/ but are NOT exporter
# output: parity CONFIG, not oracle output. `--check` regenerates the corpus and
# byte/tolerance-diffs it against the committed tree; a file the exporter never
# writes would otherwise be flagged "present in committed corpus, MISSING from
# regeneration". `tolerances.json` (issue #15) is the single source of truth for
# cross-engine (native vs WASM) simulation tolerances and is hand-authored +
# reviewed, so it is excluded from the reproducibility diff. This is a
# comparator-only exclusion: nothing here generates, reads, or mutates a fixture,
# so it cannot let a corrupted fixture pass (the mutation self-test still bites).
IGNORED_PARITY_FILES = frozenset({"tolerances.json"})

# Tolerance for simulation float payloads (report JSON + waveform CSV numbers).
RTOL = 1e-6
ATOL = 1e-12

# The corpus manifest: (corpus_dir_name, source_path_relative_to_repo_root).
# Explicit and ordered so the corpus set is auditable and generation is stable.
# >= 15 designs: all of examples/ (incl. every examples/failing/*), samples/,
# and tests/capability_suite/complex_bms.air.xml.
CORPUS: list[tuple[str, str]] = [
    ("advanced_components", "examples/advanced_components/design.air.xml"),
    ("analog_primitives", "examples/analog_primitives/design.air.xml"),
    ("esp32_battery_sensor", "examples/esp32_battery_sensor/design.air.xml"),
    ("mixed_signal_switch", "examples/mixed_signal_switch/design.air.xml"),
    ("failing_bad_adc_divider", "examples/failing/bad_adc_divider.air.xml"),
    ("failing_i2c_without_pullups", "examples/failing/i2c_without_pullups.air.xml"),
    ("failing_invalid_pin_function", "examples/failing/invalid_pin_function.air.xml"),
    ("failing_missing_ground", "examples/failing/missing_ground.air.xml"),
    ("failing_overloaded_3v3_rail", "examples/failing/overloaded_3v3_rail.air.xml"),
    ("failing_phase3_failure", "examples/failing/phase3_failure.air.xml"),
    ("feedback_loop", "samples/feedback_loop/design.air.xml"),
    ("iot_gateway", "samples/iot_gateway/design.air.xml"),
    ("solar_charger", "samples/solar_charger/design.air.xml"),
    ("stm32_demo", "samples/stm32_demo/design.air.xml"),
    ("complex_bms", "tests/capability_suite/complex_bms.air.xml"),
]


class ExportError(RuntimeError):
    """A fatal, contributor-facing error (e.g. the ngspice version gate)."""


# The corpus README is exporter output too, so "everything under tests/golden_corpus
# comes from the exporter" holds literally -- it is regenerated (and --check'd) like
# any other artifact, never hand-edited.
CORPUS_README = """\
# Golden corpus

Frozen reference outputs of the Python oracle (issue #4). Every future
TypeScript/WASM port of the AIR engine is verified against these fixtures; the
parity tests in #7-#10 and #13-#15 consume this corpus.

## Do not hand-edit

Everything here -- including this README and ENGINE_VERSIONS -- is produced ONLY by
`scripts/export_golden.py`. Never edit a file under this directory by hand, and
never regenerate the corpus to match a port's output: if your port disagrees with a
fixture, your port is wrong until proven otherwise (AGENTS.md rule 3). To change the
corpus, change the oracle (carrying the `oracle-first` label), then regenerate.

## Regenerate / verify

```
python scripts/export_golden.py            # regenerate every artifact
python scripts/export_golden.py --check     # verify it reproduces exactly
python scripts/export_golden.py --self-test # prove --check detects a corruption
```

The exporter refuses to run unless a real ngspice whose version matches
ENGINE_VERSIONS is reachable -- the DC fallback in `simulator.py` would otherwise
produce different, silently-wrong fixtures.

## Layout (per design)

```
<design>/input.air.xml            verbatim copy of the source design
<design>/canonical.air.xml        canonicalizer output
<design>/model.json               deterministic typed-model dump (air dump-model)
<design>/diagnostics.json         full validation diagnostics
<design>/netlist.cir              SPICE compiler output (valid designs only)
<design>/graph.json               graph / SchematicIR compiler output
<design>/report/reports/*.json    ngspice simulation reports
<design>/report/waveforms/*.csv   waveform CSVs
<design>/report/probes.json       SPICE probes descriptor
```

A design with validation errors has no `netlist.cir` and no `report/` -- the
compiler is blocked by validation (matching `service.compile_design`), and that
absence is itself expected output, captured by `diagnostics.json`. A design whose
default simulation profile has no `ngspice` backend (e.g. renode-only) has no
`report/`.

## Compare contract (used by --check)

- Byte-exact: input.air.xml, canonical.air.xml, model.json, diagnostics.json,
  netlist.cir, graph.json, and report/**/probes.json.
- Tolerance (rtol 1e-6, atol 1e-12), structure byte-exact: the float payloads under
  report/ -- report JSON numeric fields and waveform CSV values. Report structure
  (JSON keys/ordering, CSV header and row count) stays byte-exact.

## Version pin

ENGINE_VERSIONS records the exact ngspice version the corpus was generated with. The
exporter and CI both fail on mismatch. The committed corpus is generated by CI
(ubuntu apt ngspice) so its pin matches the required `core-py` job's ngspice.
"""


def write_corpus_metadata(corpus_root: Path, version: str) -> None:
    """Write the corpus-level metadata files (ENGINE_VERSIONS, README.md).

    Both are exporter output; the fresh generation in ``--check`` writes them too so
    they are compared like any other artifact.
    """
    corpus_root.mkdir(parents=True, exist_ok=True)
    with (corpus_root / "ENGINE_VERSIONS").open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"ngspice={version}\n")
    with (corpus_root / "README.md").open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(CORPUS_README)


# --------------------------------------------------------------------------- #
# ngspice version gate                                                         #
# --------------------------------------------------------------------------- #
def detect_ngspice_version() -> str:
    """Return the reachable ngspice version string (e.g. ``42``), or raise.

    Aborts loudly if no real ngspice binary is reachable -- never lets the caller
    silently fall through to simulator.py's DC approximation.
    """
    exe = ngspice_path()
    if not exe:
        raise ExportError(
            "No ngspice binary reachable (AIR_NGSPICE or PATH). The corpus MUST be "
            "generated with a real ngspice; the DC fallback would produce different, "
            "silently-wrong fixtures. Install ngspice or set AIR_NGSPICE."
        )
    try:
        result = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30)
    except OSError as exc:
        raise ExportError(f"Failed to run ngspice at {exe}: {exc}") from exc
    banner = result.stdout + result.stderr
    # Banner line: "** ngspice-42 : Circuit level simulation program"
    match = re.search(r"ngspice-(\d+)", banner)
    if not match:
        raise ExportError(f"Could not parse ngspice version from banner:\n{banner[:400]}")
    return match.group(1)


def read_pinned_version() -> str | None:
    if not ENGINE_VERSIONS_PATH.exists():
        return None
    for line in ENGINE_VERSIONS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("ngspice="):
            return line.split("=", 1)[1].strip()
    return None


def write_pinned_version(version: str) -> None:
    write_corpus_metadata(CORPUS_DIR, version)


def enforce_version_gate(*, allow_pin_write: bool) -> str:
    """Return the ngspice version to use, enforcing the pin.

    On generate with no existing pin, the detected version becomes the pin.
    Otherwise the reachable ngspice MUST match the committed pin, or we abort.
    """
    detected = detect_ngspice_version()
    pinned = read_pinned_version()
    if pinned is None:
        if not allow_pin_write:
            raise ExportError(
                "No ENGINE_VERSIONS pin found and none may be written in this mode. "
                "Run a generate first to establish the pin."
            )
        write_pinned_version(detected)
        return detected
    if detected != pinned:
        raise ExportError(
            f"ngspice version mismatch: reachable ngspice is {detected!r} but the "
            f"committed corpus is pinned to {pinned!r} (tests/golden_corpus/ENGINE_VERSIONS). "
            f"The corpus MUST be generated by the pinned version. Regenerate in an "
            f"environment with ngspice {pinned}, or (if intentionally re-pinning) update "
            f"ENGINE_VERSIONS and regenerate everything."
        )
    if allow_pin_write:
        # Keep the file canonical (idempotent rewrite).
        write_pinned_version(detected)
    return detected


# --------------------------------------------------------------------------- #
# Generation                                                                   #
# --------------------------------------------------------------------------- #
def _write_text_lf(path: Path, text: str) -> None:
    """Write text with LF endings, no matter the platform."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _dumps(obj: object) -> str:
    return json.dumps(obj, indent=2, sort_keys=True) + "\n"


def generate_design(name: str, source_rel: str, corpus_root: Path) -> dict[str, object]:
    """Generate every applicable artifact for one design. Returns an inventory row."""
    source = REPO_ROOT / source_rel
    out = corpus_root / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    inventory: dict[str, object] = {"name": name, "source": source_rel, "artifacts": []}
    artifacts: list[str] = inventory["artifacts"]  # type: ignore[assignment]

    # 1. input.air.xml -- verbatim copy (normalize to LF; source is text XML).
    raw = source.read_text(encoding="utf-8")
    _write_text_lf(out / "input.air.xml", raw)
    artifacts.append("input.air.xml")

    # Parse once. A design that crashes the parser is still a fixture: capture the error.
    try:
        ir, tree = parse_file(source)
    except Exception as exc:  # noqa: BLE001 -- crashes are fixtures too
        _write_text_lf(
            out / "error.json",
            _dumps({"stage": "parse", "error_type": type(exc).__name__, "message": str(exc)}),
        )
        artifacts.append("error.json")
        inventory["status"] = "parse_error"
        return inventory

    # 2. canonical.air.xml
    _write_text_lf(out / "canonical.air.xml", canonicalize_tree(tree))
    artifacts.append("canonical.air.xml")

    # 3. model.json -- deterministic typed-model dump
    _write_text_lf(out / "model.json", _dumps(model_to_dict(ir)))
    artifacts.append("model.json")

    # 4. diagnostics.json -- full validation diagnostics (codes, severities, messages)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    diag_payload = {
        "success": not has_errors(diagnostics),
        "diagnostics": [d.to_dict() for d in diagnostics],
    }
    _write_text_lf(out / "diagnostics.json", _dumps(diag_payload))
    artifacts.append("diagnostics.json")

    # 6. graph.json -- graph compiler output (does not require validation)
    _write_text_lf(out / "graph.json", _dumps(build_graph_data(ir)))
    artifacts.append("graph.json")

    valid = not has_errors(diagnostics)
    inventory["status"] = "valid" if valid else "invalid"

    # 5. netlist.cir -- SPICE compiler output. Failing designs are blocked by
    #    validation (matching service.compile_design); their absent netlist is
    #    itself expected output, captured by diagnostics.json.
    if valid:
        with tempfile.TemporaryDirectory() as tmp:
            first_test = next(iter(ir.tests.values()), None)
            compile_spice(ir, Path(tmp), first_test)
            netlist_src = Path(tmp) / "spice" / "main.cir"
            _write_text_lf(out / "netlist.cir", netlist_src.read_text(encoding="utf-8"))
        artifacts.append("netlist.cir")

    # 7. report/ -- ngspice simulation. Only for valid designs whose default
    #    profile includes the ngspice backend (skip otherwise, per the issue).
    if valid:
        default_profile = _default_ngspice_profile(ir)
        if default_profile is not None:
            _generate_report(ir, default_profile, out, artifacts)
            inventory["profile"] = default_profile

    return inventory


def _normalize_report_paths(report: dict[str, object], tmp_path: Path) -> None:
    """Strip the nondeterministic temp-dir prefix from a report's ``artifacts``.

    ``simulator.py`` records each artifact as an ABSOLUTE path inside the run's temp
    directory (e.g. ``C:\\...\\Temp\\tmpXXXX\\spice\\main.cir``). Those paths vary
    every run and differ by platform (backslashes). We rewrite them in place to the
    stable temp-relative POSIX form (``spice/main.cir``) so the report is byte-exact
    across runs and machines -- fixing the nondeterminism at the generator, not by
    fuzzing the diff. This is the only field in the report tree that embeds a path.
    """
    raw_artifacts = report.get("artifacts")
    if not isinstance(raw_artifacts, list):
        return
    tmp_str = str(tmp_path)
    normalized: list[str] = []
    for entry in raw_artifacts:
        text = str(entry)
        # Normalize separators, then make relative to the temp root if applicable.
        text_fwd = text.replace("\\", "/")
        tmp_fwd = tmp_str.replace("\\", "/")
        if text_fwd.startswith(tmp_fwd):
            text_fwd = text_fwd[len(tmp_fwd):].lstrip("/")
        normalized.append(text_fwd)
    report["artifacts"] = normalized


def _default_ngspice_profile(ir) -> str | None:
    default = next(
        (pid for pid, p in ir.simulation_profiles.items() if p.default),
        next(iter(ir.simulation_profiles), None),
    )
    if default is None:
        return None
    profile = ir.simulation_profiles.get(default)
    if profile is None or "ngspice" not in profile.backends:
        return None
    return default


def _generate_report(ir, profile_id: str, out: Path, artifacts: list[str]) -> None:
    """Run ngspice via simulate_analog into a temp dir, then copy the deterministic
    report tree (report JSON + waveform CSVs + probes.json) into ``out/report``.

    The raw ngspice ``*.ngspice.log`` is intentionally NOT captured: it carries the
    ngspice version banner, wall-clock-ish solver traces, and float noise that is
    neither part of the issue's artifact tree nor reproducible across builds.
    """
    report_root = out / "report"
    report_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        result = simulate_analog(ir, profile_id, tmp_path)

        # report/reports/<test>.json (structure byte-exact; numbers tolerance-compared)
        for report in result.get("reports", []):  # type: ignore[union-attr]
            test_id = report["test"]
            _normalize_report_paths(report, tmp_path)
            _write_text_lf(report_root / "reports" / f"{test_id}.json", _dumps(report))
            artifacts.append(f"report/reports/{test_id}.json")

        # report/waveforms/*.csv (tolerance-compared)
        wave_src = tmp_path / "waveforms"
        if wave_src.is_dir():
            for csv_path in sorted(wave_src.glob("*.csv")):
                text = csv_path.read_text(encoding="utf-8")
                _write_text_lf(report_root / "waveforms" / csv_path.name, text)
                artifacts.append(f"report/waveforms/{csv_path.name}")

        # report/probes.json (deterministic; byte-exact)
        probes_src = tmp_path / "spice" / "probes.json"
        if probes_src.exists():
            _write_text_lf(report_root / "probes.json", probes_src.read_text(encoding="utf-8"))
            artifacts.append("report/probes.json")


def generate(corpus_root: Path) -> list[dict[str, object]]:
    inventory = []
    for name, source_rel in CORPUS:
        inventory.append(generate_design(name, source_rel, corpus_root))
    return inventory


# --------------------------------------------------------------------------- #
# Checking                                                                     #
# --------------------------------------------------------------------------- #
# Files whose parent path contains "report/" are tolerance-compared for numbers,
# EXCEPT report/probes.json which is deterministic and stays byte-exact.
def _is_tolerance_file(rel: Path) -> bool:
    parts = rel.parts
    if "report" not in parts:
        return False
    if rel.name == "probes.json":
        return False
    return True


def _numbers_close(a: float, b: float) -> bool:
    return abs(a - b) <= ATOL + RTOL * abs(b)


_NUM_TOKEN = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")


def _compare_numeric_text(expected: str, actual: str, rel: Path) -> list[str]:
    """Structure byte-exact, numbers tolerance-compared, for report float payloads.

    We split each line into non-numeric structure and numeric tokens. The structure
    (everything that is not a number: keys, punctuation, CSV headers, units) must
    match byte-for-byte; the numeric tokens are compared with tolerance. This makes
    the check reject a changed key or reordered field while tolerating last-digit
    float noise from a different ngspice build.
    """
    diffs: list[str] = []
    exp_lines = expected.splitlines()
    act_lines = actual.splitlines()
    if len(exp_lines) != len(act_lines):
        return [f"{rel}: line count differs (expected {len(exp_lines)}, got {len(act_lines)})"]
    for i, (el, al) in enumerate(zip(exp_lines, act_lines), start=1):
        exp_struct = _NUM_TOKEN.sub("\0", el)
        act_struct = _NUM_TOKEN.sub("\0", al)
        if exp_struct != act_struct:
            diffs.append(f"{rel}:{i}: structure differs\n  expected: {el!r}\n  actual:   {al!r}")
            continue
        exp_nums = _NUM_TOKEN.findall(el)
        act_nums = _NUM_TOKEN.findall(al)
        for en, an in zip(exp_nums, act_nums):
            if not _numbers_close(float(en), float(an)):
                diffs.append(
                    f"{rel}:{i}: number outside tolerance (expected {en}, got {an}, "
                    f"rtol={RTOL}, atol={ATOL})"
                )
    return diffs


def _iter_files(root: Path) -> set[Path]:
    # Exclude non-fixture parity-config files (e.g. tolerances.json, issue #15):
    # they live under the corpus dir but are hand-authored config, not exporter
    # output, so they must not be expected in a fresh regeneration (see
    # IGNORED_PARITY_FILES). Everything else is a generated fixture and is diffed.
    return {
        p.relative_to(root)
        for p in root.rglob("*")
        if p.is_file() and p.name not in IGNORED_PARITY_FILES
    }


def compare_trees(committed: Path, fresh: Path) -> list[str]:
    """Return a list of human-readable diffs; empty means identical within contract."""
    diffs: list[str] = []
    committed_files = _iter_files(committed)
    fresh_files = _iter_files(fresh)

    for missing in sorted(committed_files - fresh_files):
        diffs.append(f"{missing}: present in committed corpus, MISSING from regeneration")
    for extra in sorted(fresh_files - committed_files):
        diffs.append(f"{extra}: produced by regeneration but NOT in committed corpus")

    for rel in sorted(committed_files & fresh_files):
        exp_bytes = (committed / rel).read_bytes()
        act_bytes = (fresh / rel).read_bytes()
        if exp_bytes == act_bytes:
            continue
        if _is_tolerance_file(rel):
            try:
                exp_text = exp_bytes.decode("utf-8")
                act_text = act_bytes.decode("utf-8")
            except UnicodeDecodeError:
                diffs.append(f"{rel}: binary differs and is not UTF-8 decodable")
                continue
            diffs.extend(_compare_numeric_text(exp_text, act_text, rel))
        else:
            diffs.append(f"{rel}: BYTE MISMATCH (deterministic artifact must match exactly)")
    return diffs


def check(corpus_root: Path) -> int:
    """Regenerate into a temp dir and diff against the committed corpus."""
    if not corpus_root.exists():
        print(f"FAIL: committed corpus {corpus_root} does not exist", file=sys.stderr)
        return 1
    pinned = read_pinned_version()
    if pinned is None:
        print("FAIL: no ENGINE_VERSIONS pin committed", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp) / "golden_corpus"
        fresh.mkdir(parents=True, exist_ok=True)
        # Reproduce the corpus-level metadata (ENGINE_VERSIONS + README) so they are
        # compared like any other artifact; the pin also anchors the version gate.
        write_corpus_metadata(fresh, pinned)
        _generate_into(fresh)
        diffs = compare_trees(corpus_root, fresh)
    if diffs:
        print(f"FAIL: corpus --check found {len(diffs)} difference(s):", file=sys.stderr)
        for d in diffs[:200]:
            print(f"  - {d}", file=sys.stderr)
        return 1
    print("OK: corpus --check passed (committed corpus reproduces exactly within contract)")
    return 0


def _generate_into(corpus_root: Path) -> list[dict[str, object]]:
    """Generate every design into ``corpus_root`` (which already holds ENGINE_VERSIONS)."""
    inventory = []
    for name, source_rel in CORPUS:
        inventory.append(generate_design(name, source_rel, corpus_root))
    return inventory


# --------------------------------------------------------------------------- #
# Mutation self-test (post-audit amendment: prove --check has teeth)           #
# --------------------------------------------------------------------------- #
def self_test(corpus_root: Path) -> int:
    """Corrupt one byte of a fixture copy and assert the check FAILS.

    A diff utility that quietly normalizes whitespace / float formatting makes all
    parity theater; this proves the teeth exist for BOTH the byte-exact path and
    the tolerance path.
    """
    if not corpus_root.exists():
        print("FAIL: self-test needs a committed corpus to mutate", file=sys.stderr)
        return 1

    pinned = read_pinned_version()
    if pinned is None:
        print("FAIL: self-test needs a committed ENGINE_VERSIONS pin", file=sys.stderr)
        return 1

    failures: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp) / "golden_corpus"
        shutil.copytree(corpus_root, base)

        # Case A: byte-exact artifact -- corrupt one byte of a model.json.
        target = base / "esp32_battery_sensor" / "model.json"
        data = bytearray(target.read_bytes())
        # Flip a byte in the middle to guarantee a real content change.
        idx = len(data) // 2
        data[idx] = data[idx] ^ 0x20
        target.write_bytes(bytes(data))
        with tempfile.TemporaryDirectory() as ftmp:
            fresh = Path(ftmp) / "golden_corpus"
            fresh.mkdir(parents=True)
            write_corpus_metadata(fresh, pinned)
            _generate_into(fresh)
            diffs = compare_trees(base, fresh)
        if diffs:
            print(f"  self-test A (byte-exact): OK -- mutation detected ({len(diffs)} diff)")
        else:
            failures.append("byte-exact mutation was NOT detected by --check")

        # Reset A, then Case B: tolerance artifact -- perturb a waveform number
        # far beyond tolerance and assert detection.
        shutil.rmtree(base)
        shutil.copytree(corpus_root, base)
        wave = _find_first_waveform(base)
        if wave is None:
            failures.append("no waveform CSV found to mutate for the tolerance self-test")
        else:
            lines = wave.read_text(encoding="utf-8").splitlines()
            # Line 1 is the header; mutate a data value on line 2 by +100 (>> rtol).
            if len(lines) >= 2:
                parts = lines[1].split(",")
                parts[-1] = str(float(parts[-1]) + 100.0)
                lines[1] = ",".join(parts)
                wave.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
            with tempfile.TemporaryDirectory() as ftmp:
                fresh = Path(ftmp) / "golden_corpus"
                fresh.mkdir(parents=True)
                write_corpus_metadata(fresh, pinned)
                _generate_into(fresh)
                diffs = compare_trees(base, fresh)
            if diffs:
                print(f"  self-test B (tolerance): OK -- out-of-tolerance number detected ({len(diffs)} diff)")
            else:
                failures.append("out-of-tolerance waveform mutation was NOT detected by --check")

    if failures:
        print("FAIL: mutation self-test did not catch a corruption:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print("OK: mutation self-test passed (both byte-exact and tolerance paths have teeth)")
    return 0


def _find_first_waveform(corpus_root: Path) -> Path | None:
    for name, _ in CORPUS:
        wave_dir = corpus_root / name / "report" / "waveforms"
        if wave_dir.is_dir():
            csvs = sorted(wave_dir.glob("*.csv"))
            if csvs:
                return csvs[0]
    return None


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    # Load .env so a local AIR_NGSPICE override resolves the same way the CLI does.
    # (In CI, ngspice is on PATH and there is no .env, so this is a no-op.)
    try:
        from dotenv import load_dotenv

        load_dotenv(REPO_ROOT / ".env")
    except ImportError:
        pass

    parser = argparse.ArgumentParser(description="Freeze/verify the golden corpus of oracle outputs.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="Verify the committed corpus reproduces exactly (within contract).")
    group.add_argument("--self-test", action="store_true", help="Prove --check detects a corrupted fixture (mutation test).")
    args = parser.parse_args(argv)

    try:
        version = enforce_version_gate(allow_pin_write=not (args.check or args.self_test))
    except ExportError as exc:
        print(f"ABORT: {exc}", file=sys.stderr)
        return 2

    if args.check:
        return check(CORPUS_DIR)
    if args.self_test:
        return self_test(CORPUS_DIR)

    # Default: (re)generate the committed corpus.
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    inventory = generate(CORPUS_DIR)
    total_files = sum(len(row["artifacts"]) for row in inventory)  # type: ignore[arg-type]
    print(f"Generated corpus with ngspice {version}: {len(inventory)} designs, {total_files} artifacts.")
    for row in inventory:
        print(f"  {row['name']:32s} status={row.get('status'):12s} artifacts={len(row['artifacts'])}")  # type: ignore[arg-type]
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
