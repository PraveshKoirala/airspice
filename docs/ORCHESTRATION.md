# Orchestration: how the swarm executes this roadmap

This is the operating manual for the **agent orchestrator** — the process (human or agent) that dispatches implementing agents against issues. It defines the execution order, the per-issue lifecycle, the independent verification protocol, and the gates. If this document and an issue conflict, stop and raise it on the issue.

Companion documents: [NORTH_STAR.md](NORTH_STAR.md) (what we build), [AGENTS.md](../AGENTS.md) (how implementers behave), the pinned issue #1 (live status).

## The five laws of dispatch

1. **One issue = one branch = one PR.** Branch `issue/NN-slug`, PR title `#NN: <issue title>`. No omnibus PRs, no drive-by fixes (file new issues instead). An issue may explicitly permit staged sub-PRs (e.g., a refactor-first commit); default is one.
2. **No issue starts before its wave is open** (dependency table below). "It looked ready" is not a reason; the table is.
3. **No PR merges without an independent verification agent's PASS** (protocol below) plus green required CI. The implementer never verifies their own work for the merge decision.
4. **Blocked means blocked.** An agent that cannot satisfy a criterion comments on the issue, applies the `blocked` label, and stops. The orchestrator dispatches the next unblocked issue. Nobody improvises scope to stay busy.
5. **State lives in labels and the index.** `in-progress` (claimed — exactly one agent per issue), `needs-review` (PR up, awaiting verification), `blocked` (+ comment), `oracle-first` / `guardrails-override` (special review, human checkpoint). On merge: close the issue, check it off in issue #1.

## Execution order (dependency waves)

A wave opens when the listed condition is met. Issues within a wave may run in parallel, subject to the concurrency rules below.

| Wave | Issues | Opens when |
|---|---|---|
| 0 | #2 CI | immediately — nothing else starts first |
| 1 | #3 purge · #4 corpus · #5 dev setup · #41 ground truth · #42 guardrails CI | #2 merged |
| 2 | #44 diagnostics registry | #4 merged |
| **M0 GATE** | — | corpus `--check` green twice in CI · #41 green or oracle bugs filed AND fixed · #42 checks required on `main` · gate ceremony (below) |
| 3 | #7 parser/model (+ #43 part 1, the XML security spec, drafted in parallel — #7 implements against it) | M0 gate passed |
| 4 | #8 validation | #7 merged |
| 5 | #9 SPICE emitter · #10 graph+UI · #43 part 2 (fuzzer) | #8 merged |
| 6 | #11 patches/normalizer | #9, #10 merged |
| **M1 GATE** | — | full-corpus parity green · fuzz PR-job green with ≥10 archived regressions fixed · `VITE_ENGINE=local` schematic+validation demo recorded |
| 7 | #13 WASM engine · #45 oracle-side (Python ladder, oracle-first) · #17 providers/BYOK (independent track) | M1 gate passed |
| 8 | #14 report pipeline | #13 merged |
| 9 | #15 parity CI · #45 browser-side | #14 merged |
| **M2 GATE** | — | backend-off simulation demo · halt/alter/resume criterion demonstrated · #15 green including ground-truth circuits on WASM |
| 10 | #18 tool runtime | #11, #14, #17 merged |
| 11 | #19 autonomous repair · #20 house agent (design doc may start anytime; prototype here) | #18 merged |
| **M3 GATE** | — | mock benchmark in CI · live baseline committed · zero-non-provider-network Playwright proof |
| 12 (parallel tracks after M2/M3) | UX: #22 → #23 → #24, and #25 (after #14) · Local-first: #26 → #27, #28 (needs #26; fix-me row needs #19) · Ship: #29 (after M2) → #30 → #31 · Ecosystem: #40 (after M2), #32 (registry data may start post-#8; browser UI post-#24), #33 (after #9+#32), #34 (after #22) | per-track conditions |
| 13 | #36 IR firmware blocks (oracle-first) | M2 gate + #7 merged |
| 14 | #37 mpy-wasm runtime · #38 lockstep orchestrator | #36 merged (#38 also requires #13's control-API criterion verified merged) |
| 15 | #39 co-sim surface + benchmark | #37, #38, #18, #19 merged |
| **M8 GATE** | — | cross-domain repair demo (both directions) · determinism harness green |
| FINAL | #46 out-of-the-box gate (suite builds incrementally from #29 onward; final activation here) | all planned steps active |

Concurrency rules: max 3 issues `in-progress` before the M1 gate, max 5 after. Two agents never work the same package concurrently (check open PRs' touched paths before dispatch). Parallel agents work in isolated clones/worktrees.

## Per-issue lifecycle

1. **Claim**: self-assign, apply `in-progress`. Re-read the ENTIRE issue including any "Post-audit amendments" section — amendments are equal in force to the body.
2. **Implement** on `issue/NN-slug`, rebasing on `main` before review. Follow AGENTS.md; run every command the acceptance criteria name; capture real output.
3. **PR**: fill the template — what was done, commands + real output, what was NOT done, follow-up issues filed. Apply `needs-review`.
4. **Verification** (below). Verifier verdict lands as a PR review: approve (all criteria PASS) or request-changes (any FAIL, with the failing criterion quoted).
5. **Rework loop**: implementer fixes on the same branch; re-verify. **Three rejection rounds → stop; escalate to the human maintainer** with a summary comment on the issue.
6. **Merge** (squash), close the issue with a comment linking the PR and pasting the verifier's verdict summary, tick the box in issue #1, remove labels.

## Independent verification protocol

The verifier is a **fresh agent with no memory of the implementation** — never the implementer, never an agent that advised the implementer. It receives the issue number and PR number, nothing else. Dispatch it with this prompt:

```
You are an adversarial verification agent for the AirSpice repository.
You did not write this code. Your ONLY loyalty is to the issue text.

Input: issue #NN and PR #MM in PraveshKoirala/airspice.

1. Read issue #NN completely, including any "Post-audit amendments"
   section. List every acceptance criterion and every guardrail as a
   checklist before you look at any code.
2. Read AGENTS.md. Add its mechanical rules to your checklist
   (test weakening, fixture edits, wall-clock in cosim paths,
   fixture/port separation, special-cased fixture names).
3. Check out the PR branch. Re-run every command the acceptance
   criteria name YOURSELF. Do not trust output pasted in the PR
   description — pasted output is a claim, not evidence.
4. For each criterion: verdict PASS or FAIL with one line of evidence
   (command + observed result, or file:line). "Probably fine" is FAIL.
   A criterion you cannot verify by running or reading is FAIL with
   reason "unverifiable as specified" — that is a finding about the
   PR, not about you.
5. Actively hunt the shortcut the guardrails section predicts: diff
   the tests (weakened? deleted? skipped?), diff the fixtures (touched
   without oracle-first label?), grep for the banned patterns, check
   that parity comparisons are byte-level where the issue says byte.
6. Verdict: APPROVE only if every checklist item is PASS. Otherwise
   REQUEST CHANGES listing each FAIL with its evidence. Do not
   negotiate criteria, do not suggest the criterion "may be too
   strict" — if you believe a criterion is wrong, say so in a
   separate note, but the verdict still follows the criterion as
   written.

Output: the checklist with verdicts, then the final verdict.
```

Verification of the verifier: the maintainer (or a second agent) periodically re-runs verification on an already-approved PR; a divergent verdict is a process incident — record it on issue #42.

## Milestone gate ceremony

A milestone gate is not a feeling. To pass one: (1) all its issues closed; (2) the gate evidence (demo recording, CI links, checklist) posted as a comment on the milestone's epic issue; (3) the epic closed; (4) issue #1 updated. The next wave's dispatches may begin only after step 4. Gate evidence is produced by a verification agent, not the implementers of the milestone's issues.

## Human checkpoints (require the maintainer personally)

- Merges of #2, #4, #41, #42 (the foundation everything inherits)
- Any PR labeled `oracle-first` or `guardrails-override`
- Any change to prompts, tolerances files, ADRs, NORTH_STAR.md, AGENTS.md, or this document
- Any dependency addition beyond the issues' pre-approved lists
- The M0 gate, the v1.0 tag (#46), and any escalation after three rejection rounds

## When reality diverges from the plan

Dependencies proved wrong, an issue turns out mis-scoped, a spike invalidates an ADR: the orchestrator does not silently reroute. File the finding on the affected issue, propose the wave-table change as a PR to this document, get the human checkpoint, then continue. The plan bends in the open or it breaks in the dark.
