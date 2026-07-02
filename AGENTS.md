# Rules of engagement for implementing agents

You are one of several agents building AirSpice from GitHub issues. These rules exist because agents under completion pressure take shortcuts that look like progress and are actually damage. Every rule below was written in anticipation of a specific shortcut. They are not suggestions.

## The prime directive

**If an acceptance criterion is impossible, ambiguous, or seems wrong — STOP and comment on the issue.** Redefining the criterion, weakening the test, or quietly shipping a subset is the single worst thing you can do here. An honest "blocked because X" comment is a good outcome. A green checkmark hiding a hollow implementation is the failure mode this file exists to prevent.

## Verification is not optional

1. Before claiming completion, run the full relevant gates and **paste real output in the PR**: `python -m pytest tests/` for Python changes, `npm run build` + `npm test` in the affected package for TS changes, plus every command the issue's acceptance criteria name.
2. Never weaken, delete, skip, or mark-expected-fail an existing test to get green. Never add `continue-on-error`, `|| true`, `-k` filters, `.skip`, or broadened `try/except` to hide failures. If a test fails, the code is wrong or the test found a real issue — investigate, don't silence.
3. **Golden fixtures are the contract.** `tests/golden_corpus/` is produced only by `scripts/export_golden.py` from the Python oracle. If your output disagrees with a fixture, your code is wrong until proven otherwise. Never hand-edit fixtures. Never regenerate them to match your output. If you believe a fixture is genuinely wrong, open an issue with evidence.
4. Parity means what the issue says it means: byte-exact where stated, tolerance-based only where the issue defines a tolerance. "Close enough" and `toMatchObject` are not parity.

## Architecture invariants (violating these = automatic rejection)

5. **The XML IR is the only source of truth.** No shadow state, no sidecar files, no "temporary" caches of design data outside the document.
6. **One write path.** Nothing — not the agent, not the UI, not a test helper — mutates a design except through normalize → validate → apply. If you find yourself writing design XML with string manipulation, stop.
7. **Zero-backend default.** No feature may require a server. If your implementation "temporarily" calls a server, it is not an implementation of the issue.
8. **The main thread is sacred.** Parsing, layout, simulation, and firmware execution run in workers. A busy main thread is a bug even if the feature works.
9. **No wall-clock time in simulation semantics.** Firmware and analog share one virtual clock. `Date.now()`/`performance.now()` in a co-simulation path is a correctness bug, not a style issue.
10. **Determinism.** Same inputs → identical outputs, across runs and platforms. Sort your keys, define your orderings, seed your randomness. Nondeterminism discovered later costs 100x what it costs now.

## Fixture/port separation (mechanically enforced)

A pull request may touch `tests/golden_corpus/**` OR a port package (`packages/air-ts`, `sim-wasm`, `mpy-wasm`, `cosim`, `agent`, `ui`) — never both, unless the PR carries the `oracle-first` label and describes the intentional oracle change it implements. This is the mechanical form of ADR 0009: it makes "adjust the oracle until my port passes" impossible to do quietly. Guardrails CI (issue #42) enforces this and the other grep-able rules in this file; an enforced rule failing in CI is not an obstacle to route around — it is the review working.

## Scope discipline

11. Implement the issue, not your improved version of it. Behavior changes, refactors, and "while I was here" fixes belong in separate issues — file them, don't ship them.
12. New dependencies require a stated bundle-size impact in the PR description. Heavy deps (chart libs, utility grab-bags) need prior sign-off on the issue.
13. Do not special-case fixture or benchmark inputs anywhere in product code. If `grep -ri "bad_adc"` matches outside tests, you cheated.
14. Prompts (`prompts` modules) are tuned product surface. Porting = verbatim. Editing them requires benchmark evidence attached to the PR.
15. Secrets never enter the repo, logs, error messages, or telemetry. `.env` stays local. User API keys exist only in the browser's local storage and in direct calls to the chosen provider.

## When you finish

16. The PR description must contain: what you did, the exact commands you ran with their real output, what you did NOT do (explicitly), and any follow-up issues you filed. A reviewer should be able to reject or accept without running anything.
