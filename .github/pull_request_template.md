<!--
This template encodes AGENTS.md rule 16: the PR description must contain what
you did, the exact commands you ran with their real output, what you did NOT do
(explicitly), and any follow-up issues you filed. A reviewer should be able to
accept or reject without running anything. Do not delete these sections; fill
them in. Empty sections are treated as a criterion not met.
-->

Closes #<!-- issue number -->

## What was done

<!-- Summary of the change, scoped to the issue. Implement the issue, not your
improved version of it (AGENTS.md rule 11). -->

## Commands run + real output

<!-- Paste the ACTUAL output (not a claim that it passed) of every gate and
every command the issue's acceptance criteria name. For Python:
`python -m pytest tests/`. For TS: `npm run build` + `npm test` in the affected
package. (AGENTS.md rules 1 and 16.) -->

```
$ <command>
<paste real output here>
```

## What was NOT done

<!-- Explicitly list anything deferred, out of scope, or left for a follow-up.
Behavior changes, refactors, and "while I was here" fixes belong in separate
issues (AGENTS.md rule 11). Silence here reads as "nothing deferred". -->

## Follow-up issues filed

<!-- Links to any issues you opened for out-of-scope work discovered while
implementing. Write "None." if there are none. -->

---

### Review checklist (self-attest before requesting review)

- [ ] No existing test weakened, deleted, skipped, or marked expected-fail; no `continue-on-error` / `|| true` / broadened `try/except` added to hide failures (AGENTS.md rule 2).
- [ ] Golden fixtures not hand-edited or regenerated to match my output (AGENTS.md rule 3).
- [ ] This PR does not touch both `tests/golden_corpus/**` and a port package unless it carries the `oracle-first` label (fixture/port separation).
- [ ] No wall-clock time (`Date.now`/`performance.now`/`setTimeout`/`setInterval`) added to a co-simulation path outside a `*.progress.ts` file (AGENTS.md rules 9, 22).
- [ ] No fixture/benchmark design names special-cased in product code (AGENTS.md rule 13).
- [ ] No secrets, API keys, or `.env` contents added to the repo, logs, or errors (AGENTS.md rule 15).
- [ ] New dependencies (if any) have a stated bundle-size impact (AGENTS.md rule 12).

<!--
================================================================================
## Guardrails override
--------------------------------------------------------------------------------
ONLY fill this in if you have added the `guardrails-override` label because a
guardrail check fires on a change that is nonetheless correct. State WHICH check
(e.g. R1 fixture-port-separation) and WHY the exception is justified, with an
issue reference. The guardrails job will pass but print this justification into
its job summary so the exception is visible at PR level. There is no inline
suppression syntax; this section is the only way to waive a check.

Uncomment the header below and write the justification:

## Guardrails override

<which check fired and why the exception is justified — reference an issue>
================================================================================
-->
