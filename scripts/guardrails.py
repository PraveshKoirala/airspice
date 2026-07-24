#!/usr/bin/env python3
"""Guardrails CI: the mechanical enforcement of AGENTS.md.

This checker converts every grep-able rule in AGENTS.md into a deterministic,
diff-aware gate. It uses ONLY regex/path logic -- no AI, no heuristics -- so
that every failure is explainable, reproducible, and stable across runs and
platforms (it is expected to run on ubuntu CI and locally on Windows, pure
stdlib, no third-party deps).

Rules implemented (issue #42, #56, #69):
  R1 fixture-port-separation  AGENTS.md rule (fixture/port separation, ADR 0009;
                              on push events -- which cannot carry the
                              oracle-first label -- R1 reports informationally
                              instead of failing, issue #71)
  R2 test-weakening           AGENTS.md rule 2
  R3 wall-clock-ban           AGENTS.md rules 9 / 22
  R4 fixture-special-casing   AGENTS.md rule 13
  R5 secret-hygiene           AGENTS.md rule 15
  R6 guardrails-self-protection  issue #56 (any PR touching the enforcement
                              layer must carry the override label + section;
                              on push events -- which cannot carry a label --
                              R6 reports informationally instead of failing,
                              issue #69)

Two entry modes:
  * CI / local diff check (default): reconstruct the change under review from a
    unified diff + the changed-file list + the PR labels + the PR body, run all
    rules, print a readable report, and exit non-zero on any violation (unless
    the `guardrails-override` label + a justification section is present).
  * `--self-test`: run every rule against synthetic violating and clean diffs
    and assert each fires exactly when it should. If the checker itself is
    broken (e.g. a regex typo), this fails and, wired into the workflow, fails
    the guardrails job.

Nothing here reads the network. The GitHub event payload (labels, PR body) and
the git diff are gathered by the workflow and handed in as files/args, so the
core logic is a pure function of its inputs and fully unit-testable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# Force UTF-8 stdout/stderr so the checker behaves identically on ubuntu CI and
# a Windows (cp1252) console. Printed report text is kept ASCII regardless; this
# is a belt-and-suspenders guard. The job-summary file is always written UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Optional


# --------------------------------------------------------------------------- #
# Constants: the paths and patterns that encode AGENTS.md.
# --------------------------------------------------------------------------- #

# Port packages named in AGENTS.md's fixture/port separation rule and issue #42.
PORT_PACKAGES = ("air-ts", "sim-wasm", "mpy-wasm", "cosim", "agent", "ui")
PORT_PATH_RE = re.compile(
    r"^packages/(?:" + "|".join(re.escape(p) for p in PORT_PACKAGES) + r")/"
)
GOLDEN_CORPUS_PREFIX = "tests/golden_corpus/"

# Wall-clock ban applies (whole-tree) under these src trees only.
WALLCLOCK_ROOTS = ("packages/mpy-wasm/src/", "packages/cosim/src/")
# The single exempt pattern: progress-reporting lives in *.progress.ts files.
PROGRESS_EXEMPT_RE = re.compile(r"\.progress\.ts$")
WALLCLOCK_TOKENS = ("Date.now", "performance.now", "setTimeout", "setInterval")
# Match the tokens as identifiers/calls; Date.now / performance.now with the dot
# escaped, setTimeout/setInterval as word-bounded identifiers.
WALLCLOCK_RE = re.compile(
    r"(?:\bDate\.now\b|\bperformance\.now\b|\bsetTimeout\b|\bsetInterval\b)"
)

# Fixture special-casing: product source is everything except these roots.
# (Design names referenced in tests/bench/examples are legitimate.)
FIXTURE_ALLOWED_PREFIXES = ("tests/", "bench/", "examples/")
# Only look for design names inside actual source files.
SOURCE_SUFFIXES = (
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".c", ".cpp",
    ".h", ".hpp",
)

# Test-weakening tokens. Each entry: (id, human name, compiled regex).
# These match ADDED diff lines only. The pytest-skip rule has a carve-out:
# a skip WITH a reason= that references an issue is allowed.
ISSUE_REF_RE = re.compile(r"#\d+|issue|gh-\d+|ISSUE-\d+", re.IGNORECASE)

# pytest skip markers (plain and -if variants) -- flagged unless a reason=
# naming an issue is present. NOTE: comments in this file paraphrase the banned
# tokens rather than spelling them, so this file never trips its own scan.
PYTEST_SKIP_RE = re.compile(r"@pytest\.mark\.skip(?:if)?\b")
PYTEST_REASON_RE = re.compile(r"reason\s*=\s*['\"]([^'\"]*)['\"]")

# JS/TS test-weakening: dot-skip / dot-only on suite words, x-prefixed
# disabled tests, and the test-dot-todo placeholder. Word-ish boundaries so we
# don't match e.g. `array.only_thing`.
JS_SKIP_ONLY_RE = re.compile(
    r"\b(?:describe|it|test|context|suite)\s*\.\s*(?:skip|only)\b"
)
JS_XPREFIX_RE = re.compile(r"\b(?:xit|xdescribe|xcontext|xtest)\s*\(")
JS_TODO_RE = re.compile(r"\btest\s*\.\s*todo\b")

# CI-weakening tokens: continue-on-error set to true, and the OR-true idiom.
CONTINUE_ON_ERROR_RE = re.compile(r"\bcontinue-on-error\s*:\s*true\b")
OR_TRUE_RE = re.compile(r"\|\|\s*true\b")

# Secret patterns. Deliberately conservative to limit false positives, but the
# common provider key shapes are covered. Matches on ADDED lines.
SECRET_PATTERNS = [
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{10,}\b")),
    (
        "generic-assignment",
        re.compile(
            r"(?i)(?:api[_-]?key|secret[_-]?key|access[_-]?token|"
            r"client[_-]?secret|private[_-]?key)"
            r"\s*[:=]\s*['\"][A-Za-z0-9_\-/+]{16,}['\"]"
        ),
    ),
]

OVERRIDE_LABEL = "guardrails-override"
ORACLE_FIRST_LABEL = "oracle-first"
# A PR-body override must contain a justification section header, e.g.
# "## Guardrails override" (case-insensitive, any heading level).
OVERRIDE_SECTION_RE = re.compile(
    r"^#{1,6}\s*guardrails[\s_-]*override\b", re.IGNORECASE | re.MULTILINE
)

# R6 self-protection (issue #56): the enforcement layer's own files. ANY diff
# that touches one of these -- add, modify, rename, OR pure deletion -- must
# carry the override label + justification section, reusing the general
# override machinery but making it MANDATORY here rather than optional. This is
# path-based, not token-based: unlike R2/R5 (which scan '+' lines and so are
# blind to deletions), R6 keys off the touched-file list, so gutting the
# checker or ripping out the self-test step by DELETION alone still fires it.
# That deletion blind spot -- residual risk 1 from PR #52 round-2 -- is the hole
# this rule closes. Do NOT add a content exemption for these paths: a path-based
# rule needs none, and any such exemption would recreate the SELF_DEFINITION_PATHS
# self-exemption hole that PR #52 removed.
#
# Closed hole (PR #66 rework round 1, disclosed): the first revision of R6 was
# defeated by a RENAME. parse_unified_diff recorded only the destination path
# of a rename, so `git mv scripts/guardrails.py scripts/checks.py` (likewise
# the workflow file) plus gutting the rules at the new paths left neither
# guarded path in changed_files -- R6 stayed silent and CI passed with no
# override. The parser now records BOTH sides of a rename (the diff --git
# a/-side and the explicit `rename from` header), so renaming an enforcement
# file away fires R6 like any other touch. The verifier's rename-and-gut
# attack is a permanent self-test below.
#
# Event scoping (issue #69, M0 gate audit): R6 ENFORCES only in PR context.
# On push events no label can exist, so a firing R6 was unwaivable and painted
# main red on the merge push of every properly-overridden enforcement-layer PR
# (run 28712215535 after PR #66). On push, R6 findings are reported
# informationally (visible in log + job summary) but do not fail the job; the
# merged PR already passed R6 with its label. See run_all_rules and
# detect_pr_context; the disposition is fail-closed (PR context assumed unless
# the run is explicitly a push).
GUARDRAILS_SELF_PATHS = (
    ".github/workflows/guardrails.yml",
    "scripts/guardrails.py",
)

# R2 exemption model (PR #52 rework round 1 -- the ONLY exemption):
#
# Markdown documentation (*.md) is exempt from the R2 token scan, because
# markdown is never executed by a test runner or by CI -- a banned token there
# is a description of the pattern, not a use of it. NOTHING ELSE is exempt:
# not the guardrails workflow, not this checker's own source, and R5 (secrets)
# has NO exemption anywhere, markdown included. The previous per-file
# SELF_DEFINITION_PATHS allowlist was an exploitable hole (verifier attacks
# A/B/C on PR #52: CI-weakening tokens or a secret added to the guardrails'
# own files passed the scan -- the one file whose weakening disables
# enforcement was the one file the scan skipped). It was removed entirely.
#
# Instead, this file keeps itself token-clean BY CONSTRUCTION, and the
# guardrails job scans every PR, including PRs that touch this file:
#   * regex definitions use escape sequences and so never match their own
#     source text;
#   * self-test fixture strings are split via string concatenation, so the
#     assembled runtime data contains the banned token but no single source
#     line does;
#   * comments and violation messages paraphrase tokens (e.g. "OR-true")
#     instead of spelling them out.
# If you edit this file and the guardrails run flags your line, write the
# token in split/paraphrased form -- do NOT add an exemption.
MD_PROSE_SUFFIXES = (".md", ".markdown")


# --------------------------------------------------------------------------- #
# Data model.
# --------------------------------------------------------------------------- #

@dataclass
class Violation:
    rule: str
    message: str
    location: str = ""

    def format(self) -> str:
        loc = f" [{self.location}]" if self.location else ""
        return f"  ({self.rule}){loc} {self.message}"


@dataclass
class AddedLine:
    """An added line in the diff: which file, 1-based new-file line no, text."""
    path: str
    lineno: int
    text: str


@dataclass
class Change:
    """The change under review, reconstructed from a unified diff + metadata.

    changed_files : every path touched by the PR (added/modified/deleted).
    added_lines   : the '+' lines of the diff, with file + line-number context.
    labels        : PR labels (lower-cased).
    pr_body       : PR description text (for override justification).
    pr_context    : True when the run has PR context (labels/body exist and can
                    waive R6). False on push events, where no label can ever be
                    attached -- R6 then reports informationally instead of
                    failing (issue #69). FAIL-CLOSED default: True, so local
                    runs and PR simulations enforce R6 fully unless the run is
                    explicitly identified as a push event.
    """
    changed_files: list[str] = field(default_factory=list)
    added_lines: list[AddedLine] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    pr_body: str = ""
    pr_context: bool = True

    def has_label(self, name: str) -> bool:
        return name.lower() in self.labels


# --------------------------------------------------------------------------- #
# Unified-diff parsing (deterministic, stdlib only).
# --------------------------------------------------------------------------- #

_DIFF_GIT_RE = re.compile(r"^diff --git a/(.+?) b/(.+)$")
_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def parse_unified_diff(diff_text: str) -> tuple[list[str], list[AddedLine]]:
    """Parse a `git diff` unified diff into (changed_files, added_lines).

    Handles renames, new/deleted files, and multiple hunks. Added lines carry
    their post-image (new-file) line numbers. The `+++ b/<path>` header wins for
    the current file path (covers renames and 'a/dev/null' new files). For a
    rename, changed_files contains BOTH the source and the destination path
    (source from the `diff --git` header and the `rename from` line), so
    path-keyed rules see a renamed-away file as touched.
    """
    changed: list[str] = []
    added: list[AddedLine] = []
    cur_path: Optional[str] = None
    new_lineno = 0
    in_hunk = False

    for raw in diff_text.splitlines():
        m = _DIFF_GIT_RE.match(raw)
        if m:
            # New file section. Record BOTH sides of the header: for a RENAME
            # the a/<old> and b/<new> paths differ, and the source path must
            # enter changed_files too -- otherwise a `git mv` of a guarded
            # path escapes every path-keyed rule (verifier attack on PR #66
            # round 1: rename both enforcement files, gut the rules at the new
            # paths, and R6 stays silent; `git diff BASE HEAD` emits renames
            # by default, so this was the live CI diff path). For ordinary
            # add/modify/delete sections a/ == b/, so recording both is a
            # no-op there and R1-R5 behavior on non-rename diffs is unchanged.
            old_path, new_path = m.group(1), m.group(2)
            for p in (old_path, new_path):
                if p not in changed:
                    changed.append(p)
            cur_path = new_path
            in_hunk = False
            continue
        if not in_hunk and raw.startswith("rename from "):
            # Belt-and-suspenders: git's explicit rename header names the
            # source path unambiguously (the `diff --git a/... b/...` split is
            # a heuristic that can misparse exotic paths containing ' b/').
            # Extended headers appear only between the diff --git line and the
            # first hunk; the not-in_hunk guard keeps file CONTENT that starts
            # with this text (which appears as ' rename from ...' / '+rename
            # from ...' inside hunks anyway) from being misread.
            p = raw[len("rename from "):].strip()
            if p and p not in changed:
                changed.append(p)
            continue
        if not in_hunk and raw.startswith("rename to "):
            p = raw[len("rename to "):].strip()
            if p and p not in changed:
                changed.append(p)
            continue
        if raw.startswith("+++ "):
            p = raw[4:].strip()
            if p != "/dev/null":
                if p.startswith("b/"):
                    p = p[2:]
                cur_path = p
                if cur_path not in changed:
                    changed.append(cur_path)
            in_hunk = False
            continue
        if raw.startswith("--- "):
            # For deletions the +++ is /dev/null; keep the a/ path already
            # recorded from the diff --git line.
            in_hunk = False
            continue
        hm = _HUNK_RE.match(raw)
        if hm:
            new_lineno = int(hm.group(1))
            in_hunk = True
            continue
        if not in_hunk or cur_path is None:
            continue
        if raw.startswith("+"):
            added.append(AddedLine(path=cur_path, lineno=new_lineno, text=raw[1:]))
            new_lineno += 1
        elif raw.startswith("-"):
            # deletion: does not advance the new-file line counter
            pass
        elif raw.startswith("\\"):
            # "\ No newline at end of file"
            pass
        else:
            # context line
            new_lineno += 1

    return changed, added


# --------------------------------------------------------------------------- #
# Rule implementations. Each takes the Change and a corpus-name provider and
# returns a list of Violations. Corpus names are supplied lazily so the
# corpus-dependent rule can degrade gracefully when the corpus is absent.
# --------------------------------------------------------------------------- #

def rule_fixture_port_separation(change: Change) -> list[Violation]:
    """R1: touching the golden corpus AND a port package needs `oracle-first`.

    Mechanical form of ADR 0009 -- stops "adjust the oracle until my port
    passes" from happening quietly.
    """
    touched_corpus = [
        f for f in change.changed_files if f.startswith(GOLDEN_CORPUS_PREFIX)
    ]
    touched_port = [f for f in change.changed_files if PORT_PATH_RE.match(f)]
    if touched_corpus and touched_port and not change.has_label(ORACLE_FIRST_LABEL):
        sample_c = touched_corpus[0]
        sample_p = touched_port[0]
        return [
            Violation(
                rule="R1:fixture-port-separation",
                message=(
                    "PR touches the golden corpus AND a port package without the "
                    f"'{ORACLE_FIRST_LABEL}' label. corpus={sample_c} "
                    f"port={sample_p} "
                    "(add the label and describe the intentional oracle change, "
                    "or split the PR)."
                ),
            )
        ]
    return []


def rule_test_weakening(change: Change) -> list[Violation]:
    """R2: flag test-weakening tokens introduced in ADDED lines.

    The ONLY exemption is markdown documentation prose (never executed by a
    test runner or CI). Workflow files -- including the guardrails workflow
    itself -- and all source files are ALWAYS scanned; see the exemption-model
    comment at MD_PROSE_SUFFIXES (verifier attacks A/B on PR #52).
    """
    out: list[Violation] = []
    for al in change.added_lines:
        # Documentation prose: a banned token in markdown describes a pattern,
        # it cannot weaken a test or a CI job.
        if al.path.endswith(MD_PROSE_SUFFIXES):
            continue
        text = al.text
        loc = f"{al.path}:{al.lineno}"
        stripped = text.strip()

        # pytest skip: allowed only with reason= that references an issue.
        if PYTEST_SKIP_RE.search(text):
            reason_m = PYTEST_REASON_RE.search(text)
            has_issue_reason = bool(reason_m and ISSUE_REF_RE.search(reason_m.group(1)))
            if not has_issue_reason:
                out.append(Violation(
                    "R2:test-weakening", f"pytest skip without issue-referencing "
                    f"reason=: {stripped!r}", loc))
            continue

        if JS_SKIP_ONLY_RE.search(text):
            out.append(Violation(
                "R2:test-weakening", f".skip/.only on a test suite: {stripped!r}", loc))
            continue
        if JS_XPREFIX_RE.search(text):
            out.append(Violation(
                "R2:test-weakening", f"disabled test (x-prefix): {stripped!r}", loc))
            continue
        if JS_TODO_RE.search(text):
            out.append(Violation(
                "R2:test-weakening", f"test-todo placeholder: {stripped!r}", loc))
            continue
        if CONTINUE_ON_ERROR_RE.search(text):
            out.append(Violation(
                "R2:test-weakening", f"continue-on-error masks failures: {stripped!r}",
                loc))
            continue
        if OR_TRUE_RE.search(text):
            out.append(Violation(
                "R2:test-weakening", f"OR-true swallows a nonzero exit: {stripped!r}",
                loc))
            continue
    return out


def rule_wallclock_ban(change: Change, tree_root: Optional[Path]) -> list[Violation]:
    """R3: wall-clock APIs banned (whole-tree) under mpy-wasm/cosim src trees.

    This is a WHOLE-TREE check per the issue: it scans every file currently
    under the guarded roots, not just the diff, so a pre-existing violation is
    still caught. `*.progress.ts` files are the single exempt pattern. When no
    tree_root is available (e.g. pure self-test), the check is a no-op.
    """
    if tree_root is None:
        return []
    out: list[Violation] = []
    for root in WALLCLOCK_ROOTS:
        base = tree_root / root
        if not base.exists():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(tree_root).as_posix()
            if PROGRESS_EXEMPT_RE.search(rel):
                continue
            # Only inspect text source; skip obvious binaries by suffix.
            if path.suffix.lower() not in (
                ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"
            ):
                continue
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for i, line in enumerate(content.splitlines(), start=1):
                m = WALLCLOCK_RE.search(line)
                if m:
                    out.append(Violation(
                        "R3:wall-clock-ban",
                        f"wall-clock API '{m.group(0)}' in a co-sim path "
                        f"(move progress code to a *.progress.ts file): "
                        f"{line.strip()!r}",
                        f"{rel}:{i}"))
    return out


def rule_fixture_special_casing(
    change: Change, corpus_names: Optional[list[str]]
) -> tuple[list[Violation], bool]:
    """R4: golden-corpus design names must not appear in product source.

    Returns (violations, corpus_present). Degrades gracefully: if the corpus is
    absent (corpus_names is None), returns ([], False) -- the caller logs
    "corpus not present -- check skipped" and passes. It activates automatically
    once the corpus lands.

    A design name found in an ADDED line whose path is product source (not under
    tests/, bench/, examples/) is a violation.
    """
    if corpus_names is None:
        return [], False
    if not corpus_names:
        return [], True
    # Word-boundary match for each design name to avoid substring noise.
    name_res = [
        (n, re.compile(r"(?<![A-Za-z0-9_])" + re.escape(n) + r"(?![A-Za-z0-9_])"))
        for n in corpus_names
    ]
    out: list[Violation] = []
    for al in change.added_lines:
        path = al.path
        if path.startswith(FIXTURE_ALLOWED_PREFIXES):
            continue
        if not path.endswith(SOURCE_SUFFIXES):
            continue
        for name, rex in name_res:
            if rex.search(al.text):
                out.append(Violation(
                    "R4:fixture-special-casing",
                    f"golden-corpus design name '{name}' referenced in product "
                    f"source: {al.text.strip()!r}",
                    f"{path}:{al.lineno}"))
    return out, True


def rule_secret_hygiene(change: Change) -> list[Violation]:
    """R5: obvious API-key/secret patterns in ADDED lines.

    NO exemptions -- a secret is a secret in any file, markdown and the
    guardrails' own sources included (verifier attack C on PR #52). The
    checker's own example key shapes are concatenation-split so no source
    line contains a matching literal.
    """
    out: list[Violation] = []
    for al in change.added_lines:
        for name, rex in SECRET_PATTERNS:
            m = rex.search(al.text)
            if m:
                # Redact the match so the checker never re-leaks the secret.
                matched = m.group(0)
                redacted = matched[:4] + "...REDACTED" if len(matched) > 4 else "REDACTED"
                out.append(Violation(
                    "R5:secret-hygiene",
                    f"possible {name} in an added line (redacted: {redacted})",
                    f"{al.path}:{al.lineno}"))
                break
    return out


def _normalize_repo_path(path: str) -> str:
    """Normalize a diff path for matching: forward slashes, no leading './'.

    git itself emits forward-slash, './'-free paths, but hand-built or
    tool-mangled diffs may not, and R6 must not be evadable by cosmetic path
    spelling (verifier root-cause note on PR #66 round 1: brittle exact-match).
    Case is deliberately NOT folded: CI runs on case-sensitive Linux, where
    'Scripts/Guardrails.py' genuinely is a different path than the guarded one.
    """
    p = path.replace("\\", "/")
    while p.startswith("./"):
        p = p[2:]
    return p


def rule_guardrails_self_protection(change: Change) -> list[Violation]:
    """R6: PRs touching the enforcement layer must be explicitly overridden.

    Any change to the guardrails checker or its workflow -- including a pure
    DELETION that removes rules or the self-test step, which R2/R5 cannot see
    because they only scan added lines, and a RENAME that moves an enforcement
    file away (the parser records both sides of a rename, so the guarded
    source path still appears in changed_files) -- must carry the
    `guardrails-override` label AND the justification section. That
    combination is exactly the override machinery (checked once, centrally,
    in run_all_rules): when it is present it waives ALL violations, R6's
    included, so a properly-justified edit to this file passes; when it is
    absent R6's violation stands and the job fails. A label WITHOUT the
    section does not activate the override, so R6 (like every other rule)
    still fails -- there is no half-open path.

    Path-based by construction. R6 does NOT exempt its own definition or the
    guardrails paths from any content scan; it only reports the touch. That is
    why it needs no allowlist and cannot reintroduce the SELF_DEFINITION_PATHS
    hole PR #52 closed. Paths are normalized (separators, leading './') before
    matching; see _normalize_repo_path.
    """
    touched = [
        f for f in change.changed_files
        if _normalize_repo_path(f) in GUARDRAILS_SELF_PATHS
    ]
    if not touched:
        return []
    return [
        Violation(
            rule="R6:guardrails-self-protection",
            message=(
                "PR modifies the enforcement layer (" + ", ".join(sorted(touched))
                + "). Changes here -- including deletions that strip rules or "
                "the self-test step, and renames that move an enforcement file "
                f"away -- require the '{OVERRIDE_LABEL}' label AND a "
                "'## Guardrails override' section justifying the change "
                "(issue #56). This gate is path-based, deletion-aware, and "
                "rename-aware; it cannot be satisfied by keeping the diff "
                "token-clean."
            ),
            location=touched[0],
        )
    ]


# --------------------------------------------------------------------------- #
# Corpus discovery: read design names from the corpus itself.
# --------------------------------------------------------------------------- #

def discover_corpus_names(tree_root: Optional[Path]) -> Optional[list[str]]:
    """Read design names from tests/golden_corpus/.

    Returns None when the corpus directory does not exist (graceful degradation)
    and a sorted list of names when it does (possibly empty). We treat the
    immediate subdirectory names and the stems of top-level input files as the
    design-name set -- the corpus is organized as one directory (or input file)
    per design. Deterministic (sorted, de-duplicated).
    """
    if tree_root is None:
        return None
    corpus = tree_root / "tests" / "golden_corpus"
    if not corpus.exists() or not corpus.is_dir():
        return None
    names: set[str] = set()
    for entry in corpus.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            names.add(entry.name)
        elif entry.is_file():
            names.add(entry.stem)
    # Filter out generic names that would cause mass false-positives. These are
    # NON-design files/dirs that live under tests/golden_corpus/ whose stem is an
    # ordinary word or corpus-metadata token, not a design:
    #   README            the corpus doc
    #   index             generic
    #   ENGINE_VERSIONS   the ngspice version-pin metadata file (existed since #4)
    #   tolerances        tests/golden_corpus/tolerances.json — the issue #15
    #                     cross-engine parity CONFIG, not a design
    # Without these discards, R4 would flag every use of the word "tolerances" or
    # the token "ENGINE_VERSIONS" in the parity scripts (compare_reports.py /
    # sim_parity.mjs) as a "golden-corpus design name in product source" — pure
    # false positives (both are corpus METADATA, referenced by name necessarily).
    # Same class of generic-stem exclusion as README.
    names.discard("README")
    names.discard("index")
    names.discard("ENGINE_VERSIONS")
    names.discard("tolerances")
    # Only keep plausible identifiers (avoids matching noise).
    good = sorted(n for n in names if re.fullmatch(r"[A-Za-z0-9_-]{3,}", n or ""))
    return good


# --------------------------------------------------------------------------- #
# Orchestration: run all rules, apply override logic, print a report.
# --------------------------------------------------------------------------- #

@dataclass
class Report:
    violations: list[Violation]
    corpus_present: bool
    override_active: bool
    override_justification: str = ""
    # Findings reported for visibility but NOT failing the job. Currently only
    # R6 on push (non-PR) events lands here -- see run_all_rules (issue #69).
    informational: list[Violation] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        return bool(self.violations) and not self.override_active


def run_all_rules(change: Change, tree_root: Optional[Path]) -> Report:
    corpus_names = discover_corpus_names(tree_root)
    violations: list[Violation] = []
    violations += rule_test_weakening(change)
    violations += rule_wallclock_ban(change, tree_root)
    r4, corpus_present = rule_fixture_special_casing(change, corpus_names)
    violations += r4
    violations += rule_secret_hygiene(change)

    # R1, like R6 below, has a remedy that only a PR can carry: the
    # `oracle-first` LABEL. On a push event there is no PR, so no label can ever
    # be attached, and a firing R1 would be unwaivable -- painting main red on
    # the merge push of every legitimately-labelled oracle-first PR that spanned
    # the golden corpus AND a port package (issue #71). This is the same
    # double-jeopardy that scoped R6 to PR context in issue #69, so R1 is scoped
    # IDENTICALLY, reusing the exact same fail-closed pr_context plumbing: on
    # push (pr_context False) R1 reports INFORMATIONALLY -- printed, in the job
    # summary, but not failing; in PR context it ENFORCES exactly as before
    # (corpus+port without the oracle-first label = failure). Detection logic
    # (rule_fixture_port_separation) is untouched; only the disposition changes.
    # Fail-closed: pr_context defaults True, so local runs and PR simulations
    # enforce R1 fully unless the run is explicitly identified as a push event.
    informational: list[Violation] = []
    r1 = rule_fixture_port_separation(change)
    if change.pr_context:
        violations += r1
    else:
        informational += r1

    # R6 is the one rule whose ONLY remedy is the override label + PR-body
    # section. On a push event there is no PR: no label can ever be attached,
    # so a firing R6 would be unwaivable and paint main red on every
    # legitimately-overridden enforcement-layer merge (issue #69, M0 gate
    # audit: run 28712215535 on the merge push of PR #66). Any push to main
    # arrives via a merged PR that already passed R6 WITH its label, so
    # push-time enforcement is double jeopardy against an event surface that
    # cannot carry the waiver. On push (pr_context False) R6 therefore reports
    # INFORMATIONALLY -- printed, in the job summary, but not failing.
    # Detection logic is untouched; only the disposition changes, and only for
    # R6: every other rule enforces identically on push (a weakening token or
    # secret pushed to main still fails). Direct-push abuse of this window is
    # the domain of branch protection (PR required, no force-push), not R6.
    r6 = rule_guardrails_self_protection(change)
    if change.pr_context:
        violations += r6
    else:
        informational += r6

    override_active = False
    justification = ""
    if change.has_label(OVERRIDE_LABEL):
        sec = OVERRIDE_SECTION_RE.search(change.pr_body or "")
        if sec:
            override_active = True
            justification = _extract_section(change.pr_body, sec.start())

    return Report(
        violations=violations,
        corpus_present=corpus_present,
        override_active=override_active,
        override_justification=justification,
        informational=informational,
    )


def _extract_section(body: str, start: int) -> str:
    """Return the override section text (from its header to the next header)."""
    rest = body[start:]
    lines = rest.splitlines()
    if not lines:
        return ""
    header = lines[0]
    collected = [header]
    for line in lines[1:]:
        if re.match(r"^#{1,6}\s", line):
            break
        collected.append(line)
    return "\n".join(collected).strip()


# --------------------------------------------------------------------------- #
# GitHub Actions integration helpers (job summary / annotations).
# --------------------------------------------------------------------------- #

def write_job_summary(text: str) -> None:
    """Append to the GitHub Actions job summary if running in CI."""
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        try:
            with open(summary_path, "a", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError:
            pass


def print_report(report: Report) -> None:
    print("=" * 72)
    print("Guardrails CI - mechanized AGENTS.md")
    print("=" * 72)
    if not report.corpus_present:
        print("R4:fixture-special-casing: corpus not present - check skipped")

    if not report.violations:
        print("No guardrail violations found.")
    else:
        print(f"{len(report.violations)} guardrail violation(s) found:")
        for v in report.violations:
            print(v.format())

    if report.informational:
        print("-" * 72)
        print(f"{len(report.informational)} informational finding(s) "
              "(push event - no PR context; NOT failing the job):")
        for v in report.informational:
            print(v.format())
        print("R6 note: a push to main arrives via a merged PR that already "
              "passed R6 with its override label; the push event cannot carry "
              "a label, so enforcing here would be unwaivable (issue #69).")

    summary_lines = ["## Guardrails CI"]
    if not report.corpus_present:
        summary_lines.append("- R4 fixture-special-casing: corpus not present — check skipped")
    if report.informational:
        summary_lines.append("")
        summary_lines.append(
            f"### ℹ️ {len(report.informational)} informational finding(s) "
            "(push event — not failing)"
        )
        for v in report.informational:
            summary_lines.append(f"- {v.format().strip()}")
        summary_lines.append(
            "- R6 on push: the merged PR already passed R6 with its override "
            "label; push events cannot carry labels (issue #69)."
        )

    if report.override_active:
        print("-" * 72)
        print(f"OVERRIDE ACTIVE - label '{OVERRIDE_LABEL}' present with justification:")
        print(report.override_justification or "(no justification text found)")
        print("Job PASSES despite the violation(s) above. Override is visible at PR level.")
        summary_lines.append("")
        summary_lines.append(f"### ⚠️ Guardrails override active (`{OVERRIDE_LABEL}`)")
        summary_lines.append(
            f"{len(report.violations)} violation(s) waived by explicit override."
        )
        summary_lines.append("")
        summary_lines.append("**Justification (from PR body):**")
        summary_lines.append("")
        summary_lines.append("> " + (report.override_justification or "(none)").replace("\n", "\n> "))
        summary_lines.append("")
        summary_lines.append("<details><summary>Waived violations</summary>")
        summary_lines.append("")
        for v in report.violations:
            summary_lines.append(f"- {v.format().strip()}")
        summary_lines.append("")
        summary_lines.append("</details>")
    elif report.violations:
        summary_lines.append("")
        summary_lines.append(f"### ❌ {len(report.violations)} violation(s)")
        for v in report.violations:
            summary_lines.append(f"- {v.format().strip()}")
    else:
        summary_lines.append("")
        summary_lines.append("### ✅ No violations")

    write_job_summary("\n".join(summary_lines))


# --------------------------------------------------------------------------- #
# Input gathering for the real (CI/local) run.
# --------------------------------------------------------------------------- #

def load_labels(args: argparse.Namespace) -> list[str]:
    """Collect PR labels from --label, --labels-json, or the GH event payload."""
    labels: list[str] = []
    for lbl in args.label or []:
        labels.append(lbl)
    if args.labels_json:
        labels += [l.strip() for l in _read_json_labels(args.labels_json)]
    if args.event_path and os.path.exists(args.event_path):
        try:
            with open(args.event_path, encoding="utf-8") as fh:
                event = json.load(fh)
            pr = event.get("pull_request") or {}
            for lbl in pr.get("labels", []) or []:
                name = lbl.get("name") if isinstance(lbl, dict) else lbl
                if name:
                    labels.append(name)
        except (OSError, json.JSONDecodeError):
            pass
    return [l.lower() for l in labels if l]


def _read_json_labels(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        out = []
        for item in data:
            if isinstance(item, dict) and "name" in item:
                out.append(item["name"])
            elif isinstance(item, str):
                out.append(item)
        return out
    return []


def load_pr_body(args: argparse.Namespace) -> str:
    if args.body:
        return args.body
    if args.body_file and os.path.exists(args.body_file):
        try:
            with open(args.body_file, encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            return ""
    if args.event_path and os.path.exists(args.event_path):
        try:
            with open(args.event_path, encoding="utf-8") as fh:
                event = json.load(fh)
            pr = event.get("pull_request") or {}
            return pr.get("body") or ""
        except (OSError, json.JSONDecodeError):
            return ""
    return ""


def load_diff(args: argparse.Namespace) -> str:
    if args.diff_file and os.path.exists(args.diff_file):
        with open(args.diff_file, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        if data.strip():
            return data
    return ""


# --------------------------------------------------------------------------- #
# CLI.
# --------------------------------------------------------------------------- #

def detect_pr_context(args: argparse.Namespace) -> bool:
    """Decide whether this run has PR context (a label could waive R6).

    PAYLOAD-FIRST (PR #70 verifier hardening): a readable event payload that
    contains a `pull_request` object is AUTHORITATIVE -- the run is PR context
    regardless of `--push-event`. Otherwise the flag would outrank the payload,
    and a PR that edits guardrails.yml to pass `--push-event` to its own
    checker run would demote R6 to informational on a real PR event (the
    verifier reproduced exactly that masquerade). With payload-first ordering
    the flag only applies where it is legitimate: local runs with no event
    payload at all.

    FAIL-CLOSED: the default is True (full R6 enforcement). The run is treated
    as a push (non-PR) event ONLY when explicitly identified as one:
      * an event payload was provided (--event-path), is readable, and
        contains no `pull_request` object -- exactly how the workflow's
        push-to-main runs look, and the same payload shape
        load_labels/load_pr_body already key off (an unreadable payload counts
        as PR context, fail closed); or
      * NO event payload exists and `--push-event` was passed (local
        reproduction of the push behavior).
    Local runs without an event payload or the flag therefore always enforce
    R6 fully -- the own-diff check in DEVELOPMENT.md keeps failing without the
    label.
    """
    if args.event_path and os.path.exists(args.event_path):
        try:
            with open(args.event_path, encoding="utf-8") as fh:
                event = json.load(fh)
        except (OSError, json.JSONDecodeError):
            return True
        return bool(event.get("pull_request"))
    if getattr(args, "push_event", False):
        return False
    return True


def build_change(args: argparse.Namespace) -> Change:
    diff_text = load_diff(args)
    changed_files, added_lines = parse_unified_diff(diff_text)
    labels = load_labels(args)
    body = load_pr_body(args)
    return Change(
        changed_files=changed_files,
        added_lines=added_lines,
        labels=labels,
        pr_body=body,
        pr_context=detect_pr_context(args),
    )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Guardrails CI checker (mechanized AGENTS.md).")
    parser.add_argument("--self-test", action="store_true",
                        help="Run the checker's own fixture-based self-tests and exit.")
    parser.add_argument("--diff-file", help="Path to a unified diff file (else read stdin).")
    parser.add_argument("--label", action="append", help="A PR label (repeatable).")
    parser.add_argument("--labels-json", help="Path to a JSON list of labels/label objects.")
    parser.add_argument("--body", help="PR body text.")
    parser.add_argument("--body-file", help="Path to a file containing the PR body.")
    parser.add_argument("--event-path", help="Path to the GitHub event payload JSON.")
    parser.add_argument("--push-event", action="store_true",
                        help="Treat the run as a push (non-PR) event: R6 reports "
                             "informationally and does not fail (issue #69). "
                             "Applies ONLY when no event payload exists; a "
                             "readable payload containing a pull_request object "
                             "is authoritative and forces PR context regardless "
                             "of this flag (payload-first, PR #70 hardening). "
                             "Without this flag or a pull_request-less event "
                             "payload, R6 enforces fully (fail-closed).")
    parser.add_argument("--tree-root", default=".",
                        help="Filesystem root for whole-tree/corpus checks (default: cwd).")
    parser.add_argument("--no-tree", action="store_true",
                        help="Disable whole-tree/corpus filesystem checks (diff-only).")
    args = parser.parse_args(argv)

    if args.self_test:
        return run_self_tests()

    tree_root: Optional[Path] = None if args.no_tree else Path(args.tree_root).resolve()
    change = build_change(args)
    report = run_all_rules(change, tree_root)
    print_report(report)
    return 1 if report.failed else 0


# --------------------------------------------------------------------------- #
# Self-tests: synthetic diffs, one violating + one clean per rule, plus the
# override path and the corpus present/absent states. If any assertion fails,
# the checker is broken and the guardrails job must fail.
# --------------------------------------------------------------------------- #

def _diff_for(path: str, added: list[str]) -> str:
    """Build a minimal one-hunk unified diff adding `added` lines to `path`."""
    lines = [
        f"diff --git a/{path} b/{path}",
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        f"+++ b/{path}",
        f"@@ -0,0 +1,{len(added)} @@",
    ]
    lines += ["+" + a for a in added]
    return "\n".join(lines) + "\n"


def _deletion_diff_for(path: str, removed: list[str]) -> str:
    """Build a minimal unified diff that DELETES `path` entirely.

    Mirrors what `git diff` emits for a full file removal (`+++ /dev/null`, only
    '-' body lines, no '+' lines). Used to prove R6 catches the deletion attack
    that R2/R5's added-line scans are blind to.
    """
    lines = [
        f"diff --git a/{path} b/{path}",
        "deleted file mode 100644",
        "index 1111111..0000000",
        f"--- a/{path}",
        "+++ /dev/null",
        f"@@ -1,{len(removed)} +0,0 @@",
    ]
    lines += ["-" + r for r in removed]
    return "\n".join(lines) + "\n"


def _rename_diff_for(
    old: str, new: str,
    removed: Optional[list[str]] = None,
    added: Optional[list[str]] = None,
) -> str:
    """Build a unified diff that RENAMES `old` -> `new`, optionally with edits.

    Mirrors what `git diff` emits for a rename (`similarity index`,
    `rename from` / `rename to`); a pure rename (100% similarity) has NO
    ---/+++/hunk lines at all. Used to prove the rename-evasion attack
    (verifier, PR #66 rework round 1) now fires R6.
    """
    with_edits = bool(removed or added)
    lines = [
        f"diff --git a/{old} b/{new}",
        "similarity index 90%" if with_edits else "similarity index 100%",
        f"rename from {old}",
        f"rename to {new}",
    ]
    if with_edits:
        removed = removed or []
        added = added or []
        lines += [
            "index 1111111..2222222 100644",
            f"--- a/{old}",
            f"+++ b/{new}",
            f"@@ -1,{len(removed)} +1,{len(added)} @@",
        ]
        lines += ["-" + r for r in removed]
        lines += ["+" + a for a in added]
    return "\n".join(lines) + "\n"


def _change_from_diff(diff: str, labels: Optional[list[str]] = None, body: str = "",
                      pr_context: bool = True) -> Change:
    files, added = parse_unified_diff(diff)
    return Change(changed_files=files, added_lines=added,
                  labels=[l.lower() for l in (labels or [])], pr_body=body,
                  pr_context=pr_context)


class _SelfTest:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.log: list[str] = []

    def check(self, name: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.passed += 1
            self.log.append(f"  PASS  {name}")
        else:
            self.failed += 1
            self.log.append(f"  FAIL  {name}  {detail}")


def run_self_tests() -> int:
    st = _SelfTest()
    import tempfile

    # ---- R1 fixture/port separation ------------------------------------- #
    # Violating: corpus + port, no oracle-first label.
    diff_c = _diff_for("tests/golden_corpus/rc_lowpass/input.xml", ["<x/>"])
    diff_p = _diff_for("packages/ui/src/App.tsx", ["const x = 1;"])
    ch = _change_from_diff(diff_c + diff_p)
    st.check("R1 violating (corpus+port, no label) fires",
             len(rule_fixture_port_separation(ch)) == 1)
    # Clean A: same files WITH oracle-first label.
    ch = _change_from_diff(diff_c + diff_p, labels=["oracle-first"])
    st.check("R1 clean (oracle-first label) passes",
             rule_fixture_port_separation(ch) == [])
    # Clean B: corpus only (no port).
    ch = _change_from_diff(diff_c)
    st.check("R1 clean (corpus only) passes",
             rule_fixture_port_separation(ch) == [])

    # ---- R1 push-event scoping (issue #71) ------------------------------- #
    # R1's only PR-side remedy is the `oracle-first` LABEL, which a push event
    # cannot carry -- so a firing R1 on push was unwaivable and painted main red
    # on the merge push of every legitimately-labelled oracle-first PR that
    # spanned corpus + a port package. Mirroring the R6 fix (issue #69), R1 is
    # now routed through the SAME fail-closed pr_context plumbing: it ENFORCES
    # on a PR, reports INFORMATIONALLY on a push. Detection is unchanged -- only
    # the disposition differs by context. Fail-closed: PR context is the default
    # everywhere; push must be explicitly identified.
    r1_diff = diff_c + diff_p  # corpus + port, no oracle-first label
    # PR context (explicit): fails -- the enforcement baseline of this pair.
    rep = run_all_rules(_change_from_diff(r1_diff, pr_context=True), None)
    st.check("R1 events: PR context -> corpus+port (no label) FAILS (enforced)",
             rep.failed is True
             and any(v.rule.startswith("R1") for v in rep.violations)
             and rep.informational == [],
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]} "
                    f"info={rep.informational}")
    # Push context: same diff passes; R1 lands in informational, not violations.
    # (This assertion is RED against the pre-fix code, which enforced R1 on push.)
    rep = run_all_rules(_change_from_diff(r1_diff, pr_context=False), None)
    st.check("R1 events: push context -> corpus+port (no label) does NOT fail",
             rep.failed is False,
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]}")
    st.check("R1 events: push context -> R1 reported informationally",
             len(rep.informational) == 1
             and rep.informational[0].rule.startswith("R1")
             and not any(v.rule.startswith("R1") for v in rep.violations),
             detail=f"info={rep.informational} viols={rep.violations}")
    # PR context WITH the oracle-first label -> clean in both channels (unchanged).
    rep = run_all_rules(
        _change_from_diff(r1_diff, labels=["oracle-first"], pr_context=True), None)
    st.check("R1 events: PR context WITH oracle-first label -> clean",
             rep.failed is False
             and not any(v.rule.startswith("R1") for v in rep.violations)
             and not any(v.rule.startswith("R1") for v in rep.informational),
             detail=f"failed={rep.failed} viols={rep.violations} info={rep.informational}")
    # NO LEAK / no double-count: in push context the R1 finding is in
    # informational and NOT in the enforced violations.
    rep = run_all_rules(_change_from_diff(r1_diff, pr_context=False), None)
    st.check("R1 events: no leak -- informational R1 not also an enforced finding",
             not any(v.rule.startswith("R1") for v in rep.violations)
             and len(rep.informational) == 1
             and rep.informational[0].rule.startswith("R1"),
             detail=f"viols={[v.rule for v in rep.violations]} "
                    f"info={[v.rule for v in rep.informational]}")
    # NO LEAK (other rules): the push downgrade applies to R1 alone. A weakening
    # token pushed to main in the SAME diff still FAILS, and R1 stays
    # informational (not also enforced) in that run.
    r1_mixed = (r1_diff
                + _diff_for(".github/workflows/x.yml",
                            ["    continue-on-error" + ": true"]))
    rep = run_all_rules(_change_from_diff(r1_mixed, pr_context=False), None)
    st.check("R1 events: push context does NOT downgrade other rules (R2 fails)",
             rep.failed is True
             and any(v.rule.startswith("R2") for v in rep.violations)
             and not any(v.rule.startswith("R1") for v in rep.violations)
             and len(rep.informational) == 1
             and rep.informational[0].rule.startswith("R1"),
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]} "
                    f"info={[v.rule for v in rep.informational]}")
    # A clean push run stays clean (no phantom R1 informational findings): corpus
    # touched but NO port package -> R1 does not fire in either channel.
    rep = run_all_rules(_change_from_diff(
        _diff_for("tests/golden_corpus/rc_lowpass/input.xml", ["<y/>"]),
        pr_context=False), None)
    st.check("R1 events: corpus-only push run has no R1 findings anywhere",
             rep.failed is False
             and not any(v.rule.startswith("R1") for v in rep.informational)
             and not any(v.rule.startswith("R1") for v in rep.violations),
             detail=f"info={rep.informational} viols={rep.violations}")

    # ---- R2 test-weakening ---------------------------------------------- #
    # Fixture strings are concatenation-split: the assembled runtime value
    # contains the banned token, but no single SOURCE line of this file does,
    # so this file passes its own scan without any exemption.
    r2_viol = [
        ("py-skip-no-reason", 'packages/core/tests/test_x.py',
         ["@pytest" + ".mark.skip"]),
        ("py-skip-reason-no-issue", 'packages/core/tests/test_x.py',
         ['@pytest' + '.mark.skip(reason="flaky")']),
        ("js-skip", 'packages/ui/src/a.test.ts', ["describe" + ".skip('x', () => {})"]),
        ("js-only", 'packages/ui/src/a.test.ts', ["it" + ".only('x', () => {})"]),
        ("x-prefix-test", 'packages/ui/src/a.test.ts', ["x" + "it('x', () => {})"]),
        ("x-prefix-suite", 'packages/ui/src/a.test.ts', ["x" + "describe('x', () => {})"]),
        ("test-todo", 'packages/ui/src/a.test.ts', ["test" + ".todo('later')"]),
        ("continue-on-error", '.github/workflows/x.yml',
         ["    continue-on-error" + ": true"]),
        ("or-true", '.github/workflows/x.yml', ["    run: pytest |" + "| true"]),
    ]
    for name, path, added in r2_viol:
        ch = _change_from_diff(_diff_for(path, added))
        st.check(f"R2 violating ({name}) fires",
                 len(rule_test_weakening(ch)) >= 1,
                 detail=f"got {rule_test_weakening(ch)}")
    # Clean A: pytest skip WITH issue-referencing reason.
    ch = _change_from_diff(_diff_for(
        "packages/core/tests/test_x.py",
        ['@pytest.mark.skip(reason="blocked by #123 until fixed")']))
    st.check("R2 clean (pytest skip w/ issue reason) passes",
             rule_test_weakening(ch) == [])
    # Clean B: ordinary code with no weakening tokens.
    ch = _change_from_diff(_diff_for(
        "packages/ui/src/a.test.ts", ["it('does a thing', () => { expect(1).toBe(1); })"]))
    st.check("R2 clean (normal test) passes", rule_test_weakening(ch) == [])
    # Clean C: the word 'only' as a non-test property must NOT fire.
    ch = _change_from_diff(_diff_for(
        "packages/core/src/x.ts", ["const readOnly = config.only_flag;"]))
    st.check("R2 clean (unrelated 'only' identifier) passes",
             rule_test_weakening(ch) == [])
    # ---- Verifier attacks A/B/C (PR #52 rework round 1) ------------------ #
    # The former per-file self-exemption let these pass; they must now FAIL.
    # ATTACK A: continue-on-error added to the guardrails workflow itself.
    ch = _change_from_diff(_diff_for(
        ".github/workflows/guardrails.yml",
        ["        continue-on-error" + ": true"]))
    st.check("ATTACK A: continue-on-error in guardrails.yml FIRES",
             len(rule_test_weakening(ch)) == 1,
             detail=f"got {rule_test_weakening(ch)}")
    # ATTACK B: OR-true appended to the workflow's own self-test line, which
    # would make a broken checker non-fatal.
    ch = _change_from_diff(_diff_for(
        ".github/workflows/guardrails.yml",
        ["          python scripts/guardrails.py --self-test |" + "| true"]))
    st.check("ATTACK B: OR-true on the guardrails self-test line FIRES",
             len(rule_test_weakening(ch)) == 1,
             detail=f"got {rule_test_weakening(ch)}")
    # Control for A/B: any other workflow file fires identically (no special
    # treatment in either direction).
    ch = _change_from_diff(_diff_for(
        ".github/workflows/ci.yml", ["        continue-on-error" + ": true"]))
    st.check("ATTACK A control: continue-on-error in any workflow fires",
             len(rule_test_weakening(ch)) == 1)
    # Narrowed exemption: banned tokens in markdown PROSE do not fire (R2
    # only) -- markdown is never executed by a test runner or CI...
    ch = _change_from_diff(_diff_for(
        "docs/DEVELOPMENT.md",
        ["prose describing x" + "it( and continue-on-error" + ": true and |" + "| true"]))
    st.check("R2 markdown prose (tokens described, not used) passes",
             rule_test_weakening(ch) == [], detail=f"got {rule_test_weakening(ch)}")
    # ...but the SAME tokens in a non-markdown file still fire.
    ch = _change_from_diff(_diff_for("scripts/guardrails.py", ['    run: x |' + '| true']))
    st.check("R2 guardrails.py itself has NO exemption (OR-true fires)",
             len(rule_test_weakening(ch)) == 1, detail=f"got {rule_test_weakening(ch)}")

    # ---- R3 wall-clock ban (whole-tree, needs a filesystem) ------------- #
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        # Violating file under cosim/src.
        vpath = root / "packages/cosim/src/clock.ts"
        vpath.parent.mkdir(parents=True, exist_ok=True)
        vpath.write_text("export const t = Date.now();\n", encoding="utf-8")
        viol = rule_wallclock_ban(Change(), root)
        st.check("R3 violating (Date.now in cosim/src) fires", len(viol) == 1,
                 detail=f"got {viol}")
        # Exempt: same token in a *.progress.ts file.
        ppath = root / "packages/cosim/src/report.progress.ts"
        ppath.write_text("export const t = performance.now();\n", encoding="utf-8")
        # Remove the violating file so only the exempt one remains.
        vpath.unlink()
        viol = rule_wallclock_ban(Change(), root)
        st.check("R3 clean (*.progress.ts exempt) passes", viol == [],
                 detail=f"got {viol}")
    with tempfile.TemporaryDirectory() as td2:
        root2 = Path(td2)
        # Clean: setTimeout OUTSIDE the guarded roots is allowed.
        opath = root2 / "packages/ui/src/x.ts"
        opath.parent.mkdir(parents=True, exist_ok=True)
        opath.write_text("setTimeout(() => {}, 10);\n", encoding="utf-8")
        st.check("R3 clean (setTimeout outside cosim/mpy-wasm) passes",
                 rule_wallclock_ban(Change(), root2) == [])

    # ---- R4 fixture special-casing (corpus present + absent) ------------ #
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        corpus = root / "tests/golden_corpus"
        (corpus / "bad_adc").mkdir(parents=True, exist_ok=True)
        (corpus / "rc_lowpass").mkdir(parents=True, exist_ok=True)
        names = discover_corpus_names(root)
        st.check("R4 corpus discovery finds design names",
                 names == ["bad_adc", "rc_lowpass"], detail=f"got {names}")
        # Violating: design name in product source.
        ch = _change_from_diff(_diff_for(
            "packages/core/src/emit.py",
            ["    if design == 'bad_adc':  # special-case"]))
        v, present = rule_fixture_special_casing(ch, names)
        st.check("R4 violating (design name in product src) fires",
                 len(v) == 1 and present, detail=f"got {v}")
        # Clean A: same reference but inside tests/ is allowed.
        ch = _change_from_diff(_diff_for(
            "tests/test_emit.py", ["    assert design == 'bad_adc'"]))
        v, _ = rule_fixture_special_casing(ch, names)
        st.check("R4 clean (design name under tests/) passes", v == [], detail=f"got {v}")
        # Clean B: product source without any design name.
        ch = _change_from_diff(_diff_for(
            "packages/core/src/emit.py", ["    return netlist"]))
        v, _ = rule_fixture_special_casing(ch, names)
        st.check("R4 clean (no design name) passes", v == [], detail=f"got {v}")
    # Absent state: corpus dir missing -> skipped, passes, present=False.
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        names = discover_corpus_names(root)
        st.check("R4 corpus-absent discovery returns None (graceful)", names is None)
        ch = _change_from_diff(_diff_for(
            "packages/core/src/emit.py", ["    if design == 'bad_adc': pass"]))
        v, present = rule_fixture_special_casing(ch, names)
        st.check("R4 corpus-absent: check skipped and passes",
                 v == [] and present is False, detail=f"got present={present} v={v}")

    # ---- R5 secret hygiene ---------------------------------------------- #
    # All fixture key shapes are concatenation-split so no SOURCE line here
    # contains a matching literal (this file has no R5 exemption).
    r5_viol = [
        ("openai", "sk-" + "A" * 40),
        ("anthropic", "sk-ant-" + "B" * 40),
        ("aws", "AKIA" + "1234567890ABCDEF"),
        ("google", "AIza" + "C" * 35),
        ("github", "ghp_" + "d" * 36),
        ("generic", 'api_key = "' + "abcdef0123456789ABCDEF" + '"'),
    ]
    for name, secret in r5_viol:
        ch = _change_from_diff(_diff_for("packages/agent/src/x.ts", [f'const k = "{secret}";']))
        v = rule_secret_hygiene(ch)
        st.check(f"R5 violating ({name}) fires", len(v) >= 1, detail=f"got {v}")
        # And the checker must not re-leak the raw secret.
        leaked = any(secret in vi.message for vi in v)
        st.check(f"R5 ({name}) redacts the secret in its message", not leaked)
    # Clean: an ordinary variable that is not a secret.
    ch = _change_from_diff(_diff_for(
        "packages/agent/src/x.ts", ['const name = "hello world";']))
    st.check("R5 clean (ordinary string) passes", rule_secret_hygiene(ch) == [])
    # ATTACK C (PR #52 rework round 1): a real-shaped secret in the checker's
    # OWN source must fire -- R5 has no exemption anywhere.
    ch = _change_from_diff(_diff_for(
        "scripts/guardrails.py", ['KEY = "sk-' + "Z" * 40 + '"']))
    st.check("ATTACK C: secret in guardrails.py FIRES",
             len(rule_secret_hygiene(ch)) == 1,
             detail=f"got {rule_secret_hygiene(ch)}")
    # R5 fires in markdown too (the R2 prose exemption does NOT extend to R5).
    ch = _change_from_diff(_diff_for(
        "docs/DEVELOPMENT.md", ['example: "sk-' + "Q" * 40 + '"']))
    st.check("R5 secret in markdown still fires",
             len(rule_secret_hygiene(ch)) == 1)

    # ---- R6 guardrails self-protection (issue #56) ---------------------- #
    # The rule is path-based, so its unit-level checks assert on the touch, and
    # the label+section waiver is exercised end-to-end through run_all_rules
    # below (the override machinery it reuses).
    #
    # Violating: touch scripts/guardrails.py (ordinary modification) with no
    # override in place -> R6 fires.
    ch = _change_from_diff(_diff_for(
        "scripts/guardrails.py", ["    # a harmless-looking edit"]))
    st.check("R6 violating (touch guardrails.py, no override) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # Violating: touch the workflow file too.
    ch = _change_from_diff(_diff_for(
        ".github/workflows/guardrails.yml", ["      - name: something"]))
    st.check("R6 violating (touch guardrails.yml, no override) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # THE NAMED ATTACK (issue #56 / PR #52 residual risk 1): a deletion-only
    # diff that rips checker logic out of guardrails.py adds NO banned token, so
    # R2/R5 stay silent -- but R6 keys off the touched path and fires. This is
    # the blind spot being closed; prove both halves.
    del_diff = _deletion_diff_for(
        "scripts/guardrails.py",
        ["def rule_secret_hygiene(change):", "    return []  # gutted"])
    ch = _change_from_diff(del_diff)
    st.check("R6 DELETION ATTACK (gut guardrails.py) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    st.check("R6 DELETION ATTACK: R2/R5 are blind to it (no added tokens)",
             rule_test_weakening(ch) == [] and rule_secret_hygiene(ch) == [],
             detail=f"R2={rule_test_weakening(ch)} R5={rule_secret_hygiene(ch)}")
    # And a deletion that removes the self-test step from the workflow: same.
    del_wf = _deletion_diff_for(
        ".github/workflows/guardrails.yml",
        ["      - name: Guardrails checker self-test",
         "        run: python scripts/guardrails.py --self-test"])
    ch = _change_from_diff(del_wf)
    st.check("R6 DELETION ATTACK (remove self-test step from workflow) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # Clean A: an unrelated PR (no enforcement-layer path) is unaffected.
    ch = _change_from_diff(_diff_for(
        "packages/core/src/emit.py", ["    return netlist"]))
    st.check("R6 clean (unrelated PR) passes",
             rule_guardrails_self_protection(ch) == [])
    # Clean B: a same-named file in a DIFFERENT directory must NOT fire
    # (exact-path match, not a substring/basename match).
    ch = _change_from_diff(_diff_for(
        "vendor/scripts/guardrails.py", ["x = 1"]))
    st.check("R6 clean (same basename, different path) passes",
             rule_guardrails_self_protection(ch) == [],
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # End-to-end via run_all_rules (reusing the override machinery):
    override_body = (
        "## What was done\nEdit the checker.\n\n"
        "## Guardrails override\n"
        "Touches scripts/guardrails.py to add R6 self-protection per issue #56.\n"
    )
    touch_diff = _diff_for("scripts/guardrails.py", ["    # add R6"])
    # Without the label -> R6 stands, run fails.
    rep = run_all_rules(_change_from_diff(touch_diff), None)
    st.check("R6 e2e: touch without override label -> run fails",
             rep.failed is True and any(
                 v.rule.startswith("R6") for v in rep.violations),
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]}")
    # With label + section -> override machinery waives it, run passes, and the
    # justification is captured for the report.
    rep = run_all_rules(_change_from_diff(
        touch_diff, labels=["guardrails-override"], body=override_body), None)
    st.check("R6 e2e: touch WITH label+section -> run passes (waived)",
             rep.failed is False and rep.override_active,
             detail=f"failed={rep.failed} override={rep.override_active}")
    st.check("R6 e2e: justification captured for the report",
             "issue #56" in rep.override_justification,
             detail=f"got {rep.override_justification!r}")
    # With the label but NO section -> override does not activate; R6 still
    # fails (no half-open path; consistent with the general override contract).
    rep = run_all_rules(_change_from_diff(
        touch_diff, labels=["guardrails-override"],
        body="no override section here"), None)
    st.check("R6 e2e: label but no section -> run still fails",
             rep.failed is True,
             detail=f"failed={rep.failed}")
    # The deletion attack, end-to-end: fails without override, waived with it.
    rep = run_all_rules(_change_from_diff(del_diff), None)
    st.check("R6 e2e: deletion attack without override -> run fails",
             rep.failed is True and any(
                 v.rule.startswith("R6") for v in rep.violations),
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]}")
    rep = run_all_rules(_change_from_diff(
        del_diff, labels=["guardrails-override"], body=override_body), None)
    st.check("R6 e2e: deletion attack WITH label+section -> waived, passes",
             rep.failed is False and rep.override_active)

    # ---- R6 rename evasion (PR #66 rework round 1) ----------------------- #
    # THE VERIFIER'S ATTACK: `git mv` the enforcement files and gut the rules
    # at the NEW paths. The first R6 revision recorded only the rename
    # DESTINATION in changed_files, so neither guarded path appeared and R6
    # stayed silent -- CI green, no override. The parser now records BOTH
    # sides of a rename; prove it at every level.
    #
    # Parser level: a rename-with-edits diff records source AND destination.
    ren = _rename_diff_for(
        "scripts/guardrails.py", "scripts/checks.py",
        removed=["def rule_secret_hygiene(change):"],
        added=["def rule_secret_hygiene(change):  # gutted"])
    files, added_lines = parse_unified_diff(ren)
    st.check("RENAME parser: records BOTH sides of a rename",
             "scripts/guardrails.py" in files and "scripts/checks.py" in files,
             detail=f"got {files}")
    st.check("RENAME parser: added lines attributed to the NEW path",
             added_lines and all(a.path == "scripts/checks.py" for a in added_lines),
             detail=f"got {[a.path for a in added_lines]}")
    # Parser level: a PURE rename (100% similarity, no hunks at all) too.
    files, _ = parse_unified_diff(_rename_diff_for(
        "scripts/guardrails.py", "scripts/checks.py"))
    st.check("RENAME parser: pure rename (no hunks) records both sides",
             "scripts/guardrails.py" in files and "scripts/checks.py" in files,
             detail=f"got {files}")
    # Rule level: rename-only of one enforcement file fires R6.
    ch = _change_from_diff(_rename_diff_for(
        "scripts/guardrails.py", "scripts/checks.py"))
    st.check("R6 RENAME ATTACK (rename guardrails.py away) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # The FULL attack: rename BOTH enforcement files and gut a rule at the new
    # path (the exact reproducer from the verifier's REQUEST CHANGES).
    full_attack = (
        _rename_diff_for(
            ".github/workflows/guardrails.yml", ".github/workflows/gr.yml",
            removed=["          python scripts/guardrails.py --self-test"],
            added=["          python scripts/checks.py --self-test"])
        + _rename_diff_for(
            "scripts/guardrails.py", "scripts/checks.py",
            removed=["            if rex.search(al.text):"],
            added=["            if False:  # gutted"])
    )
    ch = _change_from_diff(full_attack)
    st.check("R6 RENAME ATTACK (rename both + gut rules) fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    rep = run_all_rules(ch, None)
    st.check("R6 e2e: rename attack without override -> run fails",
             rep.failed is True and any(
                 v.rule.startswith("R6") for v in rep.violations),
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]}")
    rep = run_all_rules(_change_from_diff(
        full_attack, labels=["guardrails-override"], body=override_body), None)
    st.check("R6 e2e: rename attack WITH label+section -> waived, passes",
             rep.failed is False and rep.override_active)
    # No false positive: renaming an UNPROTECTED file must not fire R6.
    ch = _change_from_diff(_rename_diff_for(
        "packages/core/src/emit.py", "packages/core/src/emitter.py"))
    st.check("R6 clean (rename of unprotected file) passes",
             rule_guardrails_self_protection(ch) == [],
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # Path normalization (same rework, verifier root-cause note): cosmetic
    # spellings of a guarded path must still match...
    ch = _change_from_diff(_diff_for("./scripts/guardrails.py", ["# x"]))
    st.check("R6 normalization: './'-prefixed guarded path fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    ch = _change_from_diff(_diff_for("scripts\\guardrails.py", ["# x"]))
    st.check("R6 normalization: backslash-separated guarded path fires",
             len(rule_guardrails_self_protection(ch)) == 1,
             detail=f"got {rule_guardrails_self_protection(ch)}")
    # ...but case variants deliberately do NOT (case-sensitive Linux CI: a
    # different-case path IS a different file, and folding would create false
    # positives without closing any hole on the real CI path).
    ch = _change_from_diff(_diff_for("Scripts/Guardrails.py", ["# x"]))
    st.check("R6 normalization: case variant is a different path (no fire)",
             rule_guardrails_self_protection(ch) == [],
             detail=f"got {rule_guardrails_self_protection(ch)}")

    # ---- R6 push-event scoping (issue #69) -------------------------------- #
    # On a push event no PR label can exist, so a firing R6 was unwaivable and
    # painted main red on the merge push of every properly-overridden
    # enforcement-layer PR (M0 gate audit, run 28712215535 after PR #66). On
    # push, R6 reports INFORMATIONALLY and does not fail; every other rule
    # enforces identically in both contexts. Fail-closed: PR context is the
    # default everywhere; push must be explicitly identified.
    touch_diff = _diff_for("scripts/guardrails.py", ["    # edit the checker"])
    # PR context (explicit): fails -- the enforcement baseline of this pair.
    rep = run_all_rules(_change_from_diff(touch_diff, pr_context=True), None)
    st.check("R6 events: PR context -> touch FAILS (enforced)",
             rep.failed is True and rep.informational == [],
             detail=f"failed={rep.failed} info={rep.informational}")
    # Push context: same diff passes; R6 lands in informational, not violations.
    rep = run_all_rules(_change_from_diff(touch_diff, pr_context=False), None)
    st.check("R6 events: push context -> touch does NOT fail",
             rep.failed is False,
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]}")
    st.check("R6 events: push context -> R6 reported informationally",
             len(rep.informational) == 1
             and rep.informational[0].rule.startswith("R6")
             and not any(v.rule.startswith("R6") for v in rep.violations),
             detail=f"info={rep.informational} viols={rep.violations}")
    # The deletion and rename attacks on push: informational, not failing (the
    # merged PR that produced the push already passed R6 with its label;
    # direct-push abuse is branch protection's domain, not R6's).
    rep = run_all_rules(_change_from_diff(del_diff, pr_context=False), None)
    st.check("R6 events: deletion attack on push -> informational, passes",
             rep.failed is False and len(rep.informational) == 1,
             detail=f"failed={rep.failed} info={rep.informational}")
    rep = run_all_rules(_change_from_diff(full_attack, pr_context=False), None)
    st.check("R6 events: rename attack on push -> informational, passes",
             rep.failed is False and len(rep.informational) == 1,
             detail=f"failed={rep.failed} info={rep.informational}")
    # NO LEAK: the push downgrade applies to R6 alone. A weakening token pushed
    # to main still fails, and R6 stays informational in the same run.
    mixed = (_diff_for(".github/workflows/x.yml",
                       ["    continue-on-error" + ": true"])
             + touch_diff)
    rep = run_all_rules(_change_from_diff(mixed, pr_context=False), None)
    st.check("R6 events: push context does NOT downgrade other rules (R2 fails)",
             rep.failed is True
             and any(v.rule.startswith("R2") for v in rep.violations)
             and not any(v.rule.startswith("R6") for v in rep.violations)
             and len(rep.informational) == 1,
             detail=f"failed={rep.failed} viols={[v.rule for v in rep.violations]} "
                    f"info={[v.rule for v in rep.informational]}")
    # A clean push run stays clean (no phantom informational findings).
    rep = run_all_rules(_change_from_diff(
        _diff_for("packages/core/src/ok2.py", ["x = 1"]), pr_context=False), None)
    st.check("R6 events: clean push run has no informational findings",
             rep.failed is False and rep.informational == []
             and rep.violations == [])
    # detect_pr_context: the CI-facing decision. PR payload -> True; push
    # payload (no pull_request key) -> False; no payload -> True (fail-closed);
    # --push-event flag -> False.
    with tempfile.TemporaryDirectory() as td:
        pr_event = Path(td) / "pr_event.json"
        pr_event.write_text(
            json.dumps({"pull_request": {"number": 1, "labels": []}}),
            encoding="utf-8")
        push_event = Path(td) / "push_event.json"
        push_event.write_text(
            json.dumps({"ref": "refs/heads/main", "after": "abc123"}),
            encoding="utf-8")
        ns = argparse.Namespace(push_event=False, event_path=str(pr_event))
        st.check("detect_pr_context: PR event payload -> PR context",
                 detect_pr_context(ns) is True)
        ns = argparse.Namespace(push_event=False, event_path=str(push_event))
        st.check("detect_pr_context: push event payload -> push context",
                 detect_pr_context(ns) is False)
        ns = argparse.Namespace(push_event=False, event_path=None)
        st.check("detect_pr_context: no event payload -> PR context (fail-closed)",
                 detect_pr_context(ns) is True)
        ns = argparse.Namespace(push_event=True, event_path=None)
        st.check("detect_pr_context: --push-event (no payload) forces push context",
                 detect_pr_context(ns) is False)
        # PAYLOAD-FIRST hardening (PR #70 verifier): a real PR payload is
        # authoritative and CANNOT be demoted by --push-event -- otherwise a PR
        # editing guardrails.yml to pass the flag to its own checker run would
        # get R6 informational on a genuine PR event (reproduced masquerade).
        ns = argparse.Namespace(push_event=True, event_path=str(pr_event))
        st.check("detect_pr_context: PR payload beats --push-event (payload-first)",
                 detect_pr_context(ns) is True)

    # ---- Override path --------------------------------------------------- #
    # A violation waived by the guardrails-override label + a justification.
    diff_c = _diff_for("tests/golden_corpus/x/input.xml", ["<x/>"])
    diff_p = _diff_for("packages/ui/src/App.tsx", ["const x=1;"])
    body = (
        "## What was done\nStuff.\n\n"
        "## Guardrails override\n"
        "R1 fired because this oracle change and its port land together by "
        "necessity; see issue #99.\n\n"
        "## Next\nmore\n"
    )
    ch = _change_from_diff(diff_c + diff_p, labels=["guardrails-override"], body=body)
    rep = run_all_rules(ch, None)
    st.check("Override: has violation(s)", len(rep.violations) >= 1)
    st.check("Override: label+section -> override_active True", rep.override_active)
    st.check("Override: report does NOT fail", rep.failed is False)
    st.check("Override: justification captured",
             "issue #99" in rep.override_justification,
             detail=f"got {rep.override_justification!r}")
    # Override label WITHOUT a justification section must still fail.
    ch = _change_from_diff(diff_c + diff_p, labels=["guardrails-override"], body="no section here")
    rep = run_all_rules(ch, None)
    st.check("Override: label but no section -> still fails", rep.failed is True)

    # ---- Clean full run (no violations, no override) --------------------- #
    ch = _change_from_diff(_diff_for("packages/core/src/ok.py", ["def f():", "    return 1"]))
    rep = run_all_rules(ch, None)
    st.check("Full-run clean diff: no violations, does not fail",
             rep.violations == [] and rep.failed is False)

    # ---- Report --------------------------------------------------------- #
    print("Guardrails self-test")
    print("-" * 72)
    for line in st.log:
        print(line)
    print("-" * 72)
    total = st.passed + st.failed
    print(f"{st.passed}/{total} assertions passed; {st.failed} failed.")
    return 0 if st.failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
