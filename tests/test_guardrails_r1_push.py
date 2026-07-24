"""Contract tests for guardrails R1 push-event scoping (issue #71).

Authored FROM the PRD + the current guardrails API, before the fix exists. They
pin the intended push-context routing for rule R1 (fixture/port separation),
mirroring the proven R6 push-event mechanism (issue #69 / PR #70) that already
lives in guardrails.py.

Problem (PRD-71): R1 requires the `oracle-first` LABEL when a diff touches
`tests/golden_corpus/**` AND a port package. A push (non-PR) event cannot carry
a label, so the post-merge push run of an already-approved oracle-first PR fires
R1 UNWAIVABLY and paints main red -- the same double jeopardy already fixed for
R6 on push. The fix routes R1 to `Report.informational` on push while keeping
full enforcement in PR context.

Contract asserted here:
  * PR context, corpus+port, no `oracle-first` label -> R1 ENFORCED (run fails).
    [passes on current code -- the enforcement baseline / regression guard]
  * PUSH context, corpus+port, no label -> R1 routed to `informational`, run
    does NOT fail.  [RED on current code, which enforces R1 on push; the whole
    point of the change -- see test_push_context_* below]
  * PR context, corpus+port, WITH `oracle-first` label -> clean (unchanged).
  * No leak: on push the R1 finding is informational and NOT double-counted in
    the enforced violations, and the downgrade does not suppress OTHER rules --
    R2 (test-weakening) still enforces and fails the run on push.

Everything is built with guardrails' OWN fake-diff helpers (`_diff_for`,
`_change_from_diff`) and driven through `run_all_rules`, exactly as the in-file
--self-test block does. `tree_root=None` isolates the diff-driven rules
(R1/R2/R5/R6) from the filesystem whole-tree/corpus checks (R3/R4), matching the
self-tests' `run_all_rules(..., None)` calls -- R1 keys off `change.changed_files`
(the diff), not the on-disk corpus, so no real corpus directory is needed.
"""

import sys
from pathlib import Path

# guardrails.py is a script under scripts/, not an installed package. Put that
# directory on sys.path so `import guardrails` resolves under a bare
# `python -m pytest` from the repo root as well as under any PYTHONPATH.
_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import guardrails  # noqa: E402


# A golden-corpus path + a port-package path. Touching BOTH without the
# `oracle-first` label is exactly the R1 trigger (rule_fixture_port_separation):
# GOLDEN_CORPUS_PREFIX = "tests/golden_corpus/" and packages/ui/ matches
# PORT_PATH_RE. The corpus path mirrors the R1 slice of guardrails' own
# --self-test (tests/golden_corpus/rc_lowpass/input.xml + packages/ui/src/App.tsx).
CORPUS_PATH = "tests/golden_corpus/rc_lowpass/input.xml"
PORT_PATH = "packages/ui/src/App.tsx"


def _corpus_plus_port_diff() -> str:
    """A unified diff touching the golden corpus AND a port package, built with
    guardrails' own _diff_for helper so parse_unified_diff reconstructs the same
    changed_files CI would get from a real `git diff`."""
    return (
        guardrails._diff_for(CORPUS_PATH, ["<x/>"])
        + guardrails._diff_for(PORT_PATH, ["const x = 1;"])
    )


def _has_rule(viols, prefix: str) -> bool:
    return any(v.rule.startswith(prefix) for v in viols)


def _report(diff: str, *, labels=None, pr_context: bool):
    """Run all rules over a fake diff in the given context.

    tree_root=None -> no filesystem whole-tree/corpus scan (R3/R4 no-op),
    isolating R1's diff-driven detection + routing, exactly like the in-file
    self-tests' `run_all_rules(..., None)`.
    """
    change = guardrails._change_from_diff(diff, labels=labels, pr_context=pr_context)
    return guardrails.run_all_rules(change, None)


def test_r1_detection_unchanged_in_both_contexts():
    """Sanity: the R1 detection function itself fires on corpus+port,no-label in
    BOTH contexts. The fix must change ROUTING (enforced vs informational) in
    run_all_rules, never the detection function -- this guards that invariant."""
    change_pr = guardrails._change_from_diff(
        _corpus_plus_port_diff(), pr_context=True)
    change_push = guardrails._change_from_diff(
        _corpus_plus_port_diff(), pr_context=False)
    assert len(guardrails.rule_fixture_port_separation(change_pr)) == 1
    assert len(guardrails.rule_fixture_port_separation(change_push)) == 1


def test_pr_context_corpus_port_no_label_is_enforced():
    """PR context, corpus+port, no `oracle-first` label -> R1 is an ENFORCED
    finding and the run FAILS. Passes on current code; also guards that the fix
    does not over-reach and downgrade R1 in PR context."""
    rep = _report(_corpus_plus_port_diff(), pr_context=True)
    assert rep.failed is True
    assert _has_rule(rep.violations, "R1")
    assert not _has_rule(rep.informational, "R1")


def test_push_context_corpus_port_no_label_is_informational():
    """PUSH context, corpus+port, no label -> R1 routed to `informational`; the
    run does NOT fail.

    RED on current code: run_all_rules unconditionally does
    `violations += rule_fixture_port_separation(change)` (only R6 is push-scoped
    today), so on push `rep.failed` is True and `rep.informational` is empty.
    Turns GREEN once R1 mirrors R6's push-event routing.
    """
    rep = _report(_corpus_plus_port_diff(), pr_context=False)
    assert rep.failed is False, (
        "push-context corpus+port run must not fail once R1 mirrors R6; got "
        f"violations={[v.rule for v in rep.violations]}")
    assert _has_rule(rep.informational, "R1"), (
        "R1 must be routed to the informational channel on push; got "
        f"informational={[v.rule for v in rep.informational]}")
    assert not _has_rule(rep.violations, "R1"), (
        "R1 must NOT remain in the enforced violations on push; got "
        f"violations={[v.rule for v in rep.violations]}")


def test_pr_context_corpus_port_with_oracle_label_is_clean():
    """PR context, corpus+port, WITH the `oracle-first` label -> clean.
    Unchanged by the fix: R1's detection already suppresses on the label, so it
    is neither an enforced nor an informational finding, and the run passes."""
    rep = _report(
        _corpus_plus_port_diff(),
        labels=[guardrails.ORACLE_FIRST_LABEL],
        pr_context=True)
    assert rep.failed is False
    assert not _has_rule(rep.violations, "R1")
    assert not _has_rule(rep.informational, "R1")


def test_no_leak_push_r1_informational_other_rule_still_enforces():
    """No-leak: on push the R1 finding lands in `informational` and is NOT also
    counted in the enforced violations (no double-count), AND the push downgrade
    does not suppress OTHER rules -- R2 (test-weakening) still enforces and fails
    the run. Mirrors R6's own mixed-diff no-leak self-test.
    """
    # continue-on-error:true in a workflow is an R2 violation that enforces in
    # BOTH contexts (only R1/R6 are push-scoped). Token split so this test file
    # never trips guardrails' own R2 scan on itself.
    r2_diff = guardrails._diff_for(
        ".github/workflows/x.yml", ["    continue-on-error" + ": true"])
    rep = _report(_corpus_plus_port_diff() + r2_diff, pr_context=False)

    # R2 still enforces on push -> the run fails on R2 (not on R1).
    assert rep.failed is True
    assert _has_rule(rep.violations, "R2")
    # R1 is informational, not enforced (no leak / no double-count).
    assert _has_rule(rep.informational, "R1")
    assert not _has_rule(rep.violations, "R1")
