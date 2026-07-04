# Development

Practical setup and process notes for working in the AirSpice repository.
See [AGENTS.md](../AGENTS.md) for the rules of engagement and
[ORCHESTRATION.md](ORCHESTRATION.md) for the swarm execution model.

## Guardrails CI (mechanized AGENTS.md)

`AGENTS.md` is prose; prose does not gate merges. The `guardrails` job
(`.github/workflows/guardrails.yml` + `scripts/guardrails.py`) converts every
mechanically checkable rule into a deterministic, diff-aware CI gate. It uses
regex/path logic only -- no AI, no heuristics -- so every failure is
explainable and reproducible.

### Rules enforced

| ID | Rule | Scope |
|----|------|-------|
| R1 | Fixture/port separation (ADR 0009) | A PR touching `tests/golden_corpus/**` AND any port package (`packages/{air-ts,sim-wasm,mpy-wasm,cosim,agent,ui}/**`) fails unless labeled `oracle-first`. |
| R2 | Test-weakening detection | Added lines with `.skip`/`.only`, `xit(`, `xdescribe(`, `test.todo`, `@pytest.mark.skip` without an issue-referencing `reason=`, `continue-on-error: true`, or `\|\| true` fail. |
| R3 | Wall-clock ban | `Date.now`, `performance.now`, `setTimeout`, `setInterval` anywhere under `packages/{mpy-wasm,cosim}/src` (whole-tree) fail. Only `*.progress.ts` files are exempt. |
| R4 | Fixture special-casing | Golden-corpus design names (read from the corpus itself) referenced in product source outside `tests/`, `bench/`, `examples/` fail. Degrades gracefully: when the corpus is absent the check is skipped and passes, activating automatically once the corpus lands. |
| R5 | Secret hygiene | Obvious API-key/secret patterns in any added line fail. The offending value is redacted in the message. |

R1, R2, R5 are **diff-aware** (they inspect the `+` lines / touched paths of the
change). R3 is **whole-tree** (a pre-existing violation is still caught). R4 is
diff-aware for the reference but reads the design-name list from the corpus.

### Running the checker locally

```
# Self-tests (one violating + one clean synthetic diff per rule, plus the
# override path and corpus present/absent states):
python scripts/guardrails.py --self-test

# Check your current branch against main:
git diff --no-color $(git merge-base HEAD main) HEAD > /tmp/pr.diff
python scripts/guardrails.py --diff-file /tmp/pr.diff \
    --label oracle-first          # (optional) simulate PR labels \
    --tree-root .
```

The self-test is wired into the workflow and runs **first**: if the checker
itself is broken (a regex typo), the guardrails job fails before it can
false-pass a real change.

### Override mechanism

False positives will happen. The correct response is to refine the check or use
the **visible** override -- never to delete the check or add an inline
suppression comment (there is no inline suppression syntax).

To override:

1. Add the `guardrails-override` label to the PR.
2. Add a `## Guardrails override` section to the PR description stating which
   check fired and why the exception is justified (reference an issue).

The job then passes but prints the justification into its job summary, so the
exception is visible at PR level. Both a `oracle-first` (for R1) and the general
`guardrails-override` path are human checkpoints (see ORCHESTRATION.md).

## Branch protection (`main`)

Branch protection makes the foundation CI jobs required before any PR can merge.
It is configured with `scripts/setup_branch_protection.ps1`.

**Timing (ORCHESTRATION.md amendment 2026-07-03):** enabling required checks
before those checks exist and are green on `main` would jam every PR, so
enablement is **deferred to the M0 gate ceremony**. Until then, the script is
run only in dry-run mode to show exactly what it will do.

### Intended settings

- Required status checks (strict / up-to-date): `guardrails`, `core-py`, `ui`,
  `parity`.
- Force-pushes to `main`: **disabled**.
- Branch deletion: **disabled**.
- Linear history: **required**.
- Enforce on admins: **yes**.
- Required approving reviews: **1**, with stale approvals dismissed on new
  pushes. The independent-verification protocol supplies the approval from a
  different agent than the implementer (no self-approval).
- Conversation resolution: **required**.

### Dry-run (before M0)

```powershell
# From the repo root, with gh authenticated:
./scripts/setup_branch_protection.ps1 -DryRun
```

This prints the exact `gh api` PUT call, the full JSON payload, and the
read-back command -- and makes no changes.

### Applying for real (M0 gate, maintainer only)

```powershell
./scripts/setup_branch_protection.ps1
```

This applies the protection and immediately reads the settings back for
verification. Run once by the maintainer at the M0 gate ceremony.
