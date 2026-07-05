#!/usr/bin/env python3
"""Bidirectional CI enforcement for the diagnostics registry (issue #44).

The registry (registry/diagnostics.json) is the single namespace for every
diagnostic code the platform emits. This checker keeps code and registry from
drifting, in BOTH directions:

  check 1  (registry completeness): every diagnostic code that appears in a
           golden-corpus diagnostics.json / report .json AND every code named in
           a test expectation must have an entry in the registry (active OR the
           pending section). A code that shows up in a fixture or a test but is
           not registered fails the build -- this is what makes "no code without
           a registry entry" mechanical.

  check 2  (no dead codes): every ACTIVE registry entry (the ``diagnostics``
           array) must be exercised by at least one test or corpus fixture.
           An unexercised entry is an orphan and is flagged. The ``pending``
           section is EXEMPT from check 2 until those codes land on main
           (they are codes in flight in another PR, recorded so the racing PRs
           don't break each other's CI -- see docs/diagnostics_spec.md).

Codes are discovered from three places (see the collectors below):
  * registry/diagnostics.json                -- the registered codes
  * tests/golden_corpus/**/*.json            -- corpus "code" fields (exact)
  * tests/**/*.py                            -- code identifiers named in tests

The corpus collector is exact: it reads the ``"code"`` fields, so every code a
fixture froze must be registered (check 1) with no ambiguity. The test-source
collector is necessarily heuristic (it greps SCREAMING_SNAKE tokens out of
string literals, which also catches env-var names like AIR_NGSPICE and product
identifiers like GPIO_OUT). To stay robust it counts a test token ONLY when that
token is a registered code -- the registry is the namespace authority, so a
token that is not a registered code is not treated as a diagnostic reference.
That makes test tokens a reliable "this registered code is exercised" signal
(check 2 credit) without demanding registry entries for every env var a test
happens to mention. A genuinely-emitted unregistered code still cannot hide:
emitted codes flow into the corpus / report fixtures, where the exact collector
catches them for check 1.

Design notes:
  * Dependency-free stdlib only (matches scripts/guardrails.py). Deterministic.
  * --self-test proves the checker has teeth: an unregistered code makes check 1
    fail, an unexercised active entry makes check 2 flag an orphan, and a
    pending-only code is exempt from check 2 but still satisfies check 1.
  * Orphan policy: check 2 fails on orphans by default. Codes that are known to
    be legitimately hard to exercise in the committed suite can be listed in
    KNOWN_ORPHAN_ISSUES (mapping code -> tracking issue), which downgrades them
    to a reported-but-non-fatal orphan (the issue's "each orphan has a filed
    issue" escape hatch). There are none today.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "registry" / "diagnostics.json"
CORPUS_DIR = REPO_ROOT / "tests" / "golden_corpus"
TESTS_DIR = REPO_ROOT / "tests"

# A diagnostic code token: SCREAMING_SNAKE_CASE, at least one underscore, no
# lowercase. Used to pull code identifiers out of test source. The underscore
# requirement avoids matching bare CONSTANTS like "V" or "DC"; the corpus and
# registry collectors use exact "code" fields so they are not affected.
CODE_TOKEN_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")

# A NAMESPACED code token (docs/diagnostics_spec.md scheme for NEW codes): a
# subsystem prefix, a hyphen, and a zero-padded number, e.g. SEC-001, VAL-012.
# The SCREAMING_SNAKE regex above deliberately excludes hyphens, so namespaced
# codes need their own collector -- otherwise a new SEC-/VAL-/... code exercised
# only by a name reference in a test (no golden-corpus fixture) would be flagged
# as a dead code by check 2. The prefixes match the spec's namespace table.
NAMESPACED_CODE_RE = re.compile(
    r"\b(?:VAL|PARSE|SIM|COSIM|PATCH|IMP|SEC)-[0-9]{3,}\b"
)

# Codes discovered in test .py files that are NOT platform diagnostic codes:
# test-harness / product tokens that happen to look like codes. Anything listed
# here is ignored by the test-source collector for check 1 (so it does not
# demand a registry entry). Keep this list tight and justified.
TEST_SOURCE_IGNORE = frozenset(
    {
        # tests/circuit_scenarios.py step-result markers -- internal to the E2E
        # harness's StepResult, never emitted through DiagnosticBuilder.
        "STEP_EXCEPTION",
        "GENERATION_FAILED",
    }
)

# Active-registry codes that are known orphans with a filed tracking issue.
# Maps code -> issue reference. Entries here are reported but do NOT fail
# check 2 (the issue's "or each orphan has a filed issue" allowance). Empty
# today: every active code is exercised.
KNOWN_ORPHAN_ISSUES: dict[str, str] = {}


class CheckError(Exception):
    """A hard registry-consistency failure (fails the build)."""


# --------------------------------------------------------------------------- #
# Collectors
# --------------------------------------------------------------------------- #
def load_registry(path: Path = REGISTRY_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def active_codes(registry: dict) -> set[str]:
    """Codes emitted on this branch -- the ``diagnostics`` array."""
    return {entry["code"] for entry in registry.get("diagnostics", [])}


def pending_codes(registry: dict) -> set[str]:
    """Codes in flight in another PR -- ``pending.entries``. Exempt from check 2."""
    pending = registry.get("pending") or {}
    return {entry["code"] for entry in pending.get("entries", [])}


def _codes_from_json_obj(obj: object) -> set[str]:
    """Recursively pull every ``"code": "X"`` string from a parsed JSON object."""
    found: set[str] = set()
    if isinstance(obj, dict):
        code = obj.get("code")
        if isinstance(code, str) and code:
            found.add(code)
        for value in obj.values():
            found |= _codes_from_json_obj(value)
    elif isinstance(obj, list):
        for item in obj:
            found |= _codes_from_json_obj(item)
    return found


def corpus_codes(corpus_dir: Path = CORPUS_DIR) -> set[str]:
    """Every diagnostic code appearing in a golden-corpus JSON file."""
    found: set[str] = set()
    if not corpus_dir.is_dir():
        return found
    for json_path in sorted(corpus_dir.rglob("*.json")):
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        found |= _codes_from_json_obj(data)
    return found


def test_source_tokens(tests_dir: Path = TESTS_DIR) -> set[str]:
    """SCREAMING_SNAKE tokens appearing anywhere in test .py files.

    This is the raw, unfiltered heuristic set: it includes real code references
    like ``assertIn("MISSING_GROUND", codes)`` but also env vars (AIR_NGSPICE)
    and product identifiers (GPIO_OUT) that share the shape. Callers narrow it
    to registered codes via ``test_source_codes`` -- see the module docstring --
    so the noise is discarded there. The whole file is scanned (not just string
    literals) because trying to pair quotes is fragile: an apostrophe in a
    comment or docstring (``doesn't``, ``PR #61's``) desynchronises quote pairing
    and silently drops real references. Since the result is intersected with the
    registry, scanning comments too is harmless. TEST_SOURCE_IGNORE is subtracted.
    """
    found: set[str] = set()
    if not tests_dir.is_dir():
        return found
    for py_path in sorted(tests_dir.rglob("*.py")):
        try:
            text = py_path.read_text(encoding="utf-8")
        except OSError:
            continue
        found.update(CODE_TOKEN_RE.findall(text))
        # Also collect namespaced codes (SEC-001, VAL-012, ...); the
        # SCREAMING_SNAKE regex excludes hyphens so these need their own sweep.
        found.update(NAMESPACED_CODE_RE.findall(text))
    return found - TEST_SOURCE_IGNORE


def test_source_codes(registered: set[str], tests_dir: Path = TESTS_DIR) -> set[str]:
    """Registered codes that are referenced by name in test source.

    A test naming a token equal to a registered code documents that the code is
    exercised; a token that is not a registered code is treated as noise (an env
    var / product id), never as a diagnostic reference. This keeps the signal
    robust without special-casing the codebase's env vars.
    """
    return test_source_tokens(tests_dir) & registered


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
def run_checks(
    registry: dict,
    corpus: set[str],
    test_codes: set[str],
) -> list[str]:
    """Run both checks. Return a list of human-readable failure lines
    (empty == all green). Orphans with a filed issue are reported to stdout by
    the caller but never appear here."""
    failures: list[str] = []
    active = active_codes(registry)
    pending = pending_codes(registry)
    registered = active | pending

    # ---- check 1: registry completeness (corpus + tests -> registry) ------- #
    used = corpus | test_codes
    unregistered = sorted(used - registered)
    for code in unregistered:
        where = []
        if code in corpus:
            where.append("golden corpus")
        if code in test_codes:
            where.append("test source")
        failures.append(
            f"[check 1] code {code!r} appears in {' + '.join(where)} but has NO "
            f"entry in registry/diagnostics.json (add it before it ships)."
        )

    # ---- check 2: no dead ACTIVE codes (registry -> corpus + tests) -------- #
    # Pending codes are exempt: they are not emitted on this branch yet.
    orphans = sorted(active - used)
    for code in orphans:
        if code in KNOWN_ORPHAN_ISSUES:
            continue  # reported non-fatally by the caller
        failures.append(
            f"[check 2] active registry code {code!r} is a dead code: no test or "
            f"corpus fixture exercises it. Cover it with a test/fixture, or add "
            f"it to KNOWN_ORPHAN_ISSUES with a filed issue."
        )
    return failures


def reported_orphans(registry: dict, corpus: set[str], test_codes: set[str]) -> list[str]:
    """Active codes that are orphaned but have a filed issue (non-fatal)."""
    active = active_codes(registry)
    used = corpus | test_codes
    return sorted((active - used) & KNOWN_ORPHAN_ISSUES.keys())


def main_check() -> int:
    registry = load_registry()
    registered = active_codes(registry) | pending_codes(registry)
    corpus = corpus_codes()
    test_codes = test_source_codes(registered)

    failures = run_checks(registry, corpus, test_codes)

    active = active_codes(registry)
    pending = pending_codes(registry)
    print(
        f"diagnostics registry: {len(active)} active code(s), "
        f"{len(pending)} pending code(s)."
    )
    print(
        f"discovered {len(corpus)} code(s) in the golden corpus, "
        f"{len(test_codes)} code(s) named in test source."
    )
    for code in reported_orphans(registry, corpus, test_codes):
        print(
            f"note: active code {code!r} is not directly exercised but has a "
            f"filed issue ({KNOWN_ORPHAN_ISSUES[code]}); not failing the build."
        )

    if failures:
        print("\nDIAGNOSTICS REGISTRY CHECK FAILED:\n")
        for line in failures:
            print("  " + line)
        return 1
    print("diagnostics registry check passed (both directions).")
    return 0


# --------------------------------------------------------------------------- #
# Self-test: prove the checker has teeth.
# --------------------------------------------------------------------------- #
def _self_test() -> int:
    class _T:
        def __init__(self) -> None:
            self.failed = 0

        def check(self, name: str, cond: bool) -> None:
            status = "ok  " if cond else "FAIL"
            if not cond:
                self.failed += 1
            print(f"  [{status}] {name}")

    t = _T()

    def registry_with(active: list[dict], pending: list[dict]) -> dict:
        return {
            "diagnostics": active,
            "pending": {"entries": pending},
        }

    def entry(code: str) -> dict:
        return {"code": code, "severity": "error", "namespace": "x", "owner": "x"}

    # Baseline: one active code, exercised by a test -> both checks pass.
    reg = registry_with([entry("REGGED_OK")], [])
    fails = run_checks(reg, corpus=set(), test_codes={"REGGED_OK"})
    t.check("clean: registered + exercised code passes", fails == [])

    # check 1 fires: a corpus code with no registry entry fails. The corpus is
    # the authoritative exact source -- an emitted code frozen into a fixture
    # MUST be registered.
    reg = registry_with([entry("REGGED_OK")], [])
    fails = run_checks(reg, corpus={"UNREGISTERED_CODE"}, test_codes={"REGGED_OK"})
    t.check(
        "check 1: unregistered corpus code fails",
        any("UNREGISTERED_CODE" in f and "[check 1]" in f for f in fails),
    )

    # test-token narrowing: a SCREAMING_SNAKE token that is NOT a registered
    # code (e.g. an env var like AIR_NGSPICE) is filtered out by
    # test_source_codes and never reaches run_checks as a code -> no check 1
    # failure. Modelled here by passing only the registered subset, matching how
    # test_source_codes narrows the raw tokens.
    reg = registry_with([entry("REGGED_OK")], [])
    registered = active_codes(reg) | pending_codes(reg)
    narrowed = {"REGGED_OK", "AIR_NGSPICE_LIKE_ENV"} & registered
    fails = run_checks(reg, corpus=set(), test_codes=narrowed)
    t.check(
        "check 1: unregistered test token (env-var-like) is ignored, not failed",
        not any("AIR_NGSPICE_LIKE_ENV" in f for f in fails),
    )

    # check 2 fires: an active registry code exercised by nothing is an orphan.
    reg = registry_with([entry("REGGED_OK"), entry("DEAD_CODE")], [])
    fails = run_checks(reg, corpus=set(), test_codes={"REGGED_OK"})
    t.check(
        "check 2: dead active code is flagged as orphan",
        any("DEAD_CODE" in f and "[check 2]" in f for f in fails),
    )

    # pending exemption: a pending code exercised by nothing does NOT fail
    # check 2, AND a corpus code that only matches a pending entry satisfies
    # check 1 (so the racing PR's corpus stays green).
    reg = registry_with([entry("REGGED_OK")], [entry("PENDING_CODE")])
    fails = run_checks(reg, corpus=set(), test_codes={"REGGED_OK"})
    t.check(
        "pending: unexercised pending code is exempt from check 2",
        not any("PENDING_CODE" in f for f in fails),
    )
    fails = run_checks(
        reg, corpus={"PENDING_CODE"}, test_codes={"REGGED_OK"}
    )
    t.check(
        "pending: corpus code matching only a pending entry satisfies check 1",
        not any("PENDING_CODE" in f for f in fails),
    )

    # namespaced-code discovery: a NEW hyphenated code (SEC-001) referenced by
    # name in test source must be discovered by the test-source collector, so an
    # active namespaced code covered only by a name reference (no corpus fixture)
    # is NOT flagged as a dead code by check 2. The SCREAMING_SNAKE regex does
    # not match hyphens; NAMESPACED_CODE_RE does.
    t.check(
        "namespaced: SEC-001 is NOT matched by the SCREAMING_SNAKE regex",
        CODE_TOKEN_RE.findall("assertIn('SEC-001', codes)") == [],
    )
    t.check(
        "namespaced: SEC-001 IS matched by the namespaced regex",
        NAMESPACED_CODE_RE.findall("assertIn('SEC-001', codes)") == ["SEC-001"],
    )
    t.check(
        "namespaced: every spec prefix is recognized",
        NAMESPACED_CODE_RE.findall("VAL-001 PARSE-002 SIM-003 COSIM-004 "
                                   "PATCH-005 IMP-006 SEC-007")
        == ["VAL-001", "PARSE-002", "SIM-003", "COSIM-004", "PATCH-005",
            "IMP-006", "SEC-007"],
    )
    # And end-to-end: an active SEC- code exercised only by a name reference is
    # credited (no orphan), while an unexercised one is still flagged.
    reg = registry_with([entry("SEC-001"), entry("SEC-999")], [])
    fails = run_checks(reg, corpus=set(), test_codes={"SEC-001"})
    t.check(
        "namespaced: referenced SEC-001 is not an orphan",
        not any("SEC-001" in f for f in fails),
    )
    t.check(
        "namespaced: unreferenced SEC-999 is flagged as an orphan",
        any("SEC-999" in f and "[check 2]" in f for f in fails),
    )

    # KNOWN_ORPHAN_ISSUES escape hatch: a filed-issue orphan is non-fatal.
    reg = registry_with([entry("REGGED_OK"), entry("FILED_ORPHAN")], [])
    KNOWN_ORPHAN_ISSUES["FILED_ORPHAN"] = "#999"
    try:
        fails = run_checks(reg, corpus=set(), test_codes={"REGGED_OK"})
        t.check(
            "known-orphan: filed-issue orphan does not fail check 2",
            not any("FILED_ORPHAN" in f for f in fails),
        )
        t.check(
            "known-orphan: filed-issue orphan is reported",
            reported_orphans(reg, set(), {"REGGED_OK"}) == ["FILED_ORPHAN"],
        )
    finally:
        del KNOWN_ORPHAN_ISSUES["FILED_ORPHAN"]

    # The committed registry itself parses and has a well-formed pending section.
    real = load_registry()
    t.check("real registry: parses with a diagnostics array", isinstance(real.get("diagnostics"), list))
    t.check(
        "real registry: pending section is exempt-shaped (object with entries)",
        isinstance((real.get("pending") or {}).get("entries"), list),
    )
    t.check(
        "real registry: active and pending codes do not overlap",
        active_codes(real).isdisjoint(pending_codes(real)),
    )

    print(f"\nself-test: {'PASSED' if t.failed == 0 else f'{t.failed} FAILED'}")
    return 1 if t.failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run the checker's own self-tests (proves it has teeth) and exit",
    )
    args = parser.parse_args(argv)
    if args.self_test:
        return _self_test()
    return main_check()


if __name__ == "__main__":
    sys.exit(main())
