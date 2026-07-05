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

  check 3  (source-emit registration, issue #67): every diagnostic code emitted
           DIRECTLY IN THE ORACLE SOURCE (packages/core/src/air/**.py) must have
           a registry entry (active OR pending). This closes the gap the #65
           verifier found: checks 1 and 2 only see codes that reach a corpus
           fixture or a test, so a NEW emit site whose code is not yet in any
           fixture/test was invisible to CI (two agent.py codes shipped that
           way -- XML_PARSE_ERROR, PATCH_APPLY_ERROR). Check 3 makes the
           "no code without a registry entry" rule mechanical AT THE EMIT SITE.
           Unlike check 1's heuristic test-token scan, check 3 is an exact AST
           scan of the emit patterns, so an unregistered emitted code fails the
           build directly instead of relying on it later reaching a fixture.

Codes are discovered from four places (see the collectors below):
  * registry/diagnostics.json                -- the registered codes
  * tests/golden_corpus/**/*.json            -- corpus "code" fields (exact)
  * tests/**/*.py                            -- code identifiers named in tests
  * packages/core/src/air/**.py              -- codes emitted at the source (AST)

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
check 3 AST-scans the emit sites directly (below), and emitted codes also flow
into the corpus / report fixtures where the exact collector catches them.

The source-emit collector (check 3) is an AST scan of the emit patterns the
oracle actually uses (enumerated from the source, not assumed):
  1. ``builder.make(sev, domain, "CODE", ...)`` / ``DiagnosticBuilder().make(
     ...)`` -- ANY ``*.make(...)`` call; the code is the 3rd positional arg
     (index 2) or a ``code=`` kwarg. String literal -> collected.
  2. ``code = "SIM-010"; builder.make(sev, dom, code, ...)`` -- the 3rd arg is a
     local name bound to a string literal in the same function; resolved and
     collected (simulator.py emits SIM-010 this way).
  3. raw diagnostic dict literals ``{"severity": ..., "code": "CODE", ...}`` --
     an ``ast.Dict`` with a string-literal ``"code"`` key AND a diagnostic-shape
     sibling (severity/message/domain); this catches the agent.py raw-dict emits
     that never went through DiagnosticBuilder. The ``Diagnostic.to_dict()``
     serializer (``"code": self.code``) is a passthrough, NOT an emit site (it
     re-serializes an already-minted code), so a dict whose code is ``self.code``
     is excluded by construction.
Codes the AST cannot resolve statically (a code built dynamically, e.g. from an
f-string or a non-local variable) are reported as a warning with their location
rather than silently dropped -- see EMIT_DYNAMIC handling. There are none today.

Design notes:
  * Dependency-free stdlib only (matches scripts/guardrails.py). Deterministic.
  * --self-test proves the checker has teeth: an unregistered code makes check 1
    fail, an unexercised active entry makes check 2 flag an orphan, a
    pending-only code is exempt from check 2 but still satisfies check 1, and an
    unregistered SOURCE-EMITTED code makes check 3 fail (both the builder.make
    and the raw-dict emit patterns).
  * Orphan policy: check 2 fails on orphans by default. Codes that are known to
    be legitimately hard to exercise in the committed suite can be listed in
    KNOWN_ORPHAN_ISSUES (mapping code -> tracking issue), which downgrades them
    to a reported-but-non-fatal orphan (the issue's "each orphan has a filed
    issue" escape hatch). There are none today.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "registry" / "diagnostics.json"
CORPUS_DIR = REPO_ROOT / "tests" / "golden_corpus"
TESTS_DIR = REPO_ROOT / "tests"
# The oracle source tree scanned by the source-emit collector (check 3, #67).
SRC_DIR = REPO_ROOT / "packages" / "core" / "src" / "air"

# When a raw diagnostic dict literal carries a "code" key, we only treat it as an
# emit site if it also carries one of these diagnostic-shape sibling keys. This
# distinguishes a genuine emit ({"severity": "error", "code": "X", "message":...})
# from an unrelated dict that happens to use a "code" key for something else.
_DICT_DIAGNOSTIC_SIBLINGS = frozenset({"severity", "message", "domain"})

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
# Source-emit collector (check 3, issue #67)
# --------------------------------------------------------------------------- #
def _string_literal(node: ast.AST | None) -> str | None:
    """Return the value if ``node`` is a string-literal constant, else None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _is_self_attr(node: ast.AST, attr: str) -> bool:
    """True for ``self.<attr>`` -- the Diagnostic.to_dict() passthrough shape."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr == attr
        and isinstance(node.value, ast.Name)
        and node.value.id == "self"
    )


class _EmitCollector(ast.NodeVisitor):
    """Collect every diagnostic code emitted in one source file.

    Emission patterns (all enumerated from packages/core/src/air/**.py, #67):

      * ``*.make(sev, domain, code, ...)`` -- ANY attribute call named ``make``
        (``builder.make(...)``, ``DiagnosticBuilder().make(...)``); the code is
        the 3rd positional arg (index 2) or a ``code=`` kwarg.
      * a local name bound to a string literal in the enclosing function and
        passed as that code arg (``code = "SIM-010"; builder.make(..., code,
        ...)``) is resolved to its literal.
      * raw diagnostic dict literals ``{"severity": ..., "code": "CODE", ...}``
        -- an ``ast.Dict`` whose ``"code"`` key maps to a string literal and
        that also has a diagnostic-shape sibling key. ``Diagnostic.to_dict()``'s
        ``"code": self.code`` passthrough is excluded (its code is not a literal
        AND is ``self.code``), so the serializer is never mistaken for an emit.

    ``codes`` holds every statically-resolved code. ``dynamic`` holds
    (function, lineno, description) for an emit whose code the AST cannot resolve
    statically -- reported, never silently dropped.
    """

    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.codes: set[str] = set()
        self.dynamic: list[tuple[str, int, str]] = []
        self._locals: dict[str, str] = {}
        self._func = "<module>"

    def _visit_function(self, node: ast.AST) -> None:
        saved_locals, saved_func = self._locals, self._func
        # Collect simple ``name = "LITERAL"`` bindings anywhere in this function
        # so a code passed by local name (SIM-010) resolves to its literal. We do
        # not track reassignment order (a code var is assigned once); if a name
        # were bound to two different literals we would over-collect, which is
        # safe (both would need to be registered anyway).
        self._locals = {}
        self._func = getattr(node, "name", self._func)
        for stmt in ast.walk(node):
            if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                target = stmt.targets[0]
                literal = _string_literal(stmt.value)
                if isinstance(target, ast.Name) and literal is not None:
                    self._locals[target.id] = literal
        self.generic_visit(node)
        self._locals, self._func = saved_locals, saved_func

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:  # noqa: N802
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:  # noqa: N802
        self._visit_function(node)

    def _record_code_node(self, code_node: ast.AST) -> None:
        literal = _string_literal(code_node)
        if literal is not None:
            self.codes.add(literal)
        elif isinstance(code_node, ast.Name) and code_node.id in self._locals:
            self.codes.add(self._locals[code_node.id])
        else:
            self.dynamic.append(
                (self._func, getattr(code_node, "lineno", -1), ast.dump(code_node)[:80])
            )

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr == "make":
            code_node: ast.AST | None = None
            if len(node.args) >= 3:
                code_node = node.args[2]
            for keyword in node.keywords:
                if keyword.arg == "code":
                    code_node = keyword.value
            if code_node is not None:
                self._record_code_node(code_node)
        self.generic_visit(node)

    def visit_Dict(self, node: ast.Dict) -> None:  # noqa: N802
        literal_keys: dict[str, ast.AST] = {}
        for key_node, value_node in zip(node.keys, node.values):
            key = _string_literal(key_node) if key_node is not None else None
            if key is not None:
                literal_keys[key] = value_node
        if "code" in literal_keys and (_DICT_DIAGNOSTIC_SIBLINGS & literal_keys.keys()):
            code_value = literal_keys["code"]
            # The Diagnostic.to_dict() serializer -- {"code": self.code, ...} --
            # is a passthrough, not an emit site: it re-serializes an
            # already-minted code. Exclude it explicitly so it is neither
            # collected nor reported as a dynamic emit.
            if not _is_self_attr(code_value, "code"):
                literal = _string_literal(code_value)
                if literal is not None:
                    self.codes.add(literal)
                else:
                    self.dynamic.append(
                        (self._func, node.lineno, "raw-dict code is not a literal")
                    )
        self.generic_visit(node)


def source_emit_codes(
    src_dir: Path = SRC_DIR,
) -> tuple[set[str], list[tuple[str, str, int, str]]]:
    """AST-scan the oracle source for every emitted diagnostic code.

    Returns ``(codes, dynamic)`` where ``codes`` is the set of statically
    resolved emitted codes and ``dynamic`` is a sorted list of
    ``(file, function, lineno, description)`` for emits the AST could not resolve
    to a literal (reported by the caller, never silently dropped).
    """
    codes: set[str] = set()
    dynamic: list[tuple[str, str, int, str]] = []
    if not src_dir.is_dir():
        return codes, dynamic
    for py_path in sorted(src_dir.rglob("*.py")):
        try:
            source = py_path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(py_path))
        except (OSError, SyntaxError):
            continue
        rel = py_path.relative_to(REPO_ROOT).as_posix()
        collector = _EmitCollector(rel)
        collector.visit(tree)
        codes |= collector.codes
        for func, lineno, desc in collector.dynamic:
            dynamic.append((rel, func, lineno, desc))
    dynamic.sort()
    return codes, dynamic


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
def run_checks(
    registry: dict,
    corpus: set[str],
    test_codes: set[str],
    source_codes: set[str] | None = None,
) -> list[str]:
    """Run all checks. Return a list of human-readable failure lines
    (empty == all green). Orphans with a filed issue are reported to stdout by
    the caller but never appear here.

    ``source_codes`` is the set of codes AST-collected from the oracle source
    (check 3, #67). ``None`` means "not scanned" (used by focused self-tests);
    an empty set means "scanned, nothing emitted"."""
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

    # ---- check 3: source-emit registration (source -> registry, #67) ------- #
    # Every code emitted directly in the oracle source must be registered
    # (active OR pending). This closes the gap where a new emit site whose code
    # never reached a corpus fixture or test was invisible to checks 1 and 2.
    if source_codes is not None:
        for code in sorted(source_codes - registered):
            failures.append(
                f"[check 3] code {code!r} is emitted in the oracle source "
                f"(packages/core/src/air/**.py) but has NO entry in "
                f"registry/diagnostics.json. Register it (active or pending) "
                f"before it ships -- see docs/diagnostics_spec.md."
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
    source, source_dynamic = source_emit_codes()

    failures = run_checks(registry, corpus, test_codes, source_codes=source)

    active = active_codes(registry)
    pending = pending_codes(registry)
    print(
        f"diagnostics registry: {len(active)} active code(s), "
        f"{len(pending)} pending code(s)."
    )
    print(
        f"discovered {len(corpus)} code(s) in the golden corpus, "
        f"{len(test_codes)} code(s) named in test source, "
        f"{len(source)} code(s) emitted in the oracle source."
    )
    for rel, func, lineno, desc in source_dynamic:
        print(
            f"note: source emit at {rel}:{lineno} (in {func}) has a "
            f"non-static code the AST cannot resolve ({desc}); it cannot be "
            f"checked mechanically -- verify it is registered by hand."
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
    print("diagnostics registry check passed (all three directions).")
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

    # ---- check 3 (source-emit registration, #67) --------------------------- #
    # A code emitted in the oracle source but not registered fails check 3.
    reg = registry_with([entry("REGGED_OK")], [])
    fails = run_checks(
        reg, corpus=set(), test_codes={"REGGED_OK"},
        source_codes={"REGGED_OK", "EMITTED_UNREGISTERED"},
    )
    t.check(
        "check 3: source-emitted unregistered code fails",
        any("EMITTED_UNREGISTERED" in f and "[check 3]" in f for f in fails),
    )
    # A source-emitted code that IS registered (active) passes check 3.
    reg = registry_with([entry("REGGED_OK")], [])
    fails = run_checks(
        reg, corpus=set(), test_codes={"REGGED_OK"}, source_codes={"REGGED_OK"}
    )
    t.check(
        "check 3: source-emitted registered code passes",
        not any("[check 3]" in f for f in fails),
    )
    # A source-emitted code registered only in the PENDING section satisfies
    # check 3 (in-flight codes coordinate the same way as for check 1).
    reg = registry_with([entry("REGGED_OK")], [entry("PENDING_EMIT")])
    fails = run_checks(
        reg, corpus=set(), test_codes={"REGGED_OK"},
        source_codes={"REGGED_OK", "PENDING_EMIT"},
    )
    t.check(
        "check 3: source-emitted code registered only in pending passes",
        not any("PENDING_EMIT" in f for f in fails),
    )
    # source_codes=None means "not scanned" -> check 3 is skipped entirely (used
    # by focused self-tests that only exercise checks 1/2).
    reg = registry_with([entry("REGGED_OK")], [])
    fails = run_checks(reg, corpus=set(), test_codes={"REGGED_OK"}, source_codes=None)
    t.check(
        "check 3: source_codes=None skips the check",
        not any("[check 3]" in f for f in fails),
    )

    # ---- check 3 AST collector: both emit patterns are caught --------------- #
    # The collector must extract codes from BOTH builder.make(...) calls (any
    # receiver, string-literal 3rd arg or a local var bound to a literal) AND
    # raw diagnostic dict literals, while ignoring the Diagnostic.to_dict()
    # serializer passthrough ({"code": self.code, ...}).
    def collect(src: str) -> tuple[set[str], list]:
        col = _EmitCollector("<synthetic>")
        col.visit(ast.parse(src))
        return col.codes, col.dynamic

    codes, dynamic = collect(
        "def f(builder):\n"
        "    builder.make('error', 'schema', 'MADE_LITERAL', 'msg')\n"
    )
    t.check(
        "AST: builder.make string-literal code is collected",
        codes == {"MADE_LITERAL"} and dynamic == [],
    )
    codes, _ = collect(
        "def f(builder):\n"
        "    return DiagnosticBuilder().make('error', 'x', 'CHAINED_CODE', 'm')\n"
    )
    t.check(
        "AST: chained-receiver .make code is collected",
        codes == {"CHAINED_CODE"},
    )
    codes, _ = collect(
        "def f(builder):\n"
        "    code = 'VAR_CODE'\n"
        "    builder.make('error', 'x', code, 'm')\n"
    )
    t.check(
        "AST: .make code passed as a local literal-bound var is resolved",
        codes == {"VAR_CODE"},
    )
    codes, _ = collect(
        "def f(builder):\n"
        "    builder.make('error', 'x', code='KWARG_CODE', message='m')\n"
    )
    t.check(
        "AST: .make code= kwarg is collected",
        codes == {"KWARG_CODE"},
    )
    codes, _ = collect(
        "def f():\n"
        "    return [{'severity': 'error', 'code': 'RAW_DICT_CODE', 'message': 'm'}]\n"
    )
    t.check(
        "AST: raw diagnostic dict-literal code is collected",
        codes == {"RAW_DICT_CODE"},
    )
    codes, dynamic = collect(
        "class Diagnostic:\n"
        "    def to_dict(self):\n"
        "        return {'severity': self.severity, 'code': self.code, 'message': self.message}\n"
    )
    t.check(
        "AST: to_dict() serializer ({'code': self.code}) is NOT an emit and NOT dynamic",
        codes == set() and dynamic == [],
    )
    codes, dynamic = collect(
        "def f(builder, computed):\n"
        "    builder.make('error', 'x', computed, 'm')\n"
    )
    t.check(
        "AST: a non-static .make code is reported as dynamic, not silently dropped",
        codes == set() and len(dynamic) == 1,
    )
    codes, _ = collect(
        "def f(d):\n"
        "    return d.get('code', 'ERROR')\n"
    )
    t.check(
        "AST: a dict .get('code', ...) read is NOT an emit site",
        codes == set(),
    )

    # End-to-end against the real tree: the collector finds the two agent.py
    # raw-dict codes and the SIM-010 local-var code, and every code it finds is
    # registered (so the committed source passes check 3).
    real_source, real_dynamic = source_emit_codes()
    real_reg = load_registry()
    real_registered = active_codes(real_reg) | pending_codes(real_reg)
    t.check(
        "AST(real): agent.py raw-dict codes are collected",
        {"XML_PARSE_ERROR", "PATCH_APPLY_ERROR"} <= real_source,
    )
    t.check(
        "AST(real): simulator.py local-var code SIM-010 is collected",
        "SIM-010" in real_source,
    )
    t.check(
        "AST(real): every source-emitted code is registered (check 3 passes on main)",
        real_source <= real_registered,
    )
    t.check(
        "AST(real): no unresolved dynamic emit sites in the committed source",
        real_dynamic == [],
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
