# Repair benchmark — live baseline results

Each `YYYY-MM-DD-<provider>.json` is the scored output of a live repair-benchmark
run (`npm run bench -- --provider <provider>`), committed so repair quality is
tracked over time (issue #19 deliverable 4). The mock benchmark that validates
the loop **mechanics** runs in CI (`tests/repair/bench.test.ts`, 6/6 fixed) and
is not committed here — only live runs are.

## 2026-07-05 — Anthropic `claude-sonnet-5` (`2026-07-05-anthropic.json`) — HEADLINE

**Headline: 5/6 broken circuits autonomously fixed by `claude-sonnet-5`** — above
the ≥4/6 target from issue #19. A funded Anthropic key drove the full 6-case set
end to end (`npm run bench -- --provider anthropic --model claude-sonnet-5
--max-iterations 5`); every fix went through the real air-ts gate. Each of the 5
fixes converged in a **single iteration**.

| case | outcome | iters | tokens | note |
|------|---------|-------|--------|------|
| bad_adc_divider | **FIXED** | 1 | 6601 | gated patch, first try |
| i2c_without_pullups | provider_error | 1 | 5917 | **not a rate-limit / not model quality** — see below |
| invalid_pin_function | **FIXED** | 1 | 5419 | gated patch, first try |
| missing_ground | **FIXED** | 1 | 5411 | gated patch, first try |
| overloaded_3v3_rail | **FIXED** | 1 | 5729 | gated patch, first try |
| phase3_failure | **FIXED** | 1 | 6569 | gated patch, first try |

**Totals:** 5/6 fixed, 35,646 tokens across the run. At `claude-sonnet-5`
introductory pricing ($2 in / $10 out per MTok through 2026-08-31), the whole
6-case run cost **≈ $0.10** (repair turns are input-heavy: a large design +
diagnostics context per turn, a small patch out; the absolute ceiling if every
token were billed at the output rate is ≈ $0.36).

### The one miss is a real, diagnosed defect — not the model

`i2c_without_pullups` fails **reproducibly** (confirmed in isolation with
`--only i2c_without_pullups` + retries; ~5.5–5.9k tokens spent each time, so the
model *does* engage and produce a patch). The stop reason `provider_error` is
honest but generic; the captured underlying error is:

```
Provider returned 400: invalid_request_error —
messages.0.content.1: unexpected `tool_use_id` found in `tool_result` blocks:
toolu_...  Each `tool_result` block must have a corresponding `tool_use` block
in the previous message.
```

Root cause: this case's fix needs **two** `propose_patch` tool calls in one turn
(a pull-up for SDA and one for SCL). When a turn contains tool calls, the
conversation runner reconstructs the assistant message as plain text
(`conversation.ts` appends `{ role: "assistant", content: turn.text }`, dropping
the `tool_use` blocks), then sends `tool_result` blocks referencing
`tool_use_id`s that no longer have a matching `tool_use` — Anthropic's
`/v1/messages` rejects it with a 400. The other five cases fix in a single turn
whose first proposal validates clean, so they never send a `tool_result` back and
never hit the bug.

So the miss is a **multi-tool-turn conversation-reconstruction defect** in the
Anthropic provider path (`packages/agent/src/tools/conversation.ts` line ~144 +
`packages/agent/src/providers/anthropic.ts` `buildRequestBody`), NOT a rate-limit
and NOT `claude-sonnet-5` failing to reason about the circuit. Fixing it (carry
the assistant turn's `tool_use` blocks into the message history) would very
plausibly bring this to 6/6.

## 2026-07-05 — Gemini (`2026-07-05-gemini.json`)

**Honest status: PARTIAL baseline — blocked by free-tier daily quota, NOT model
quality.** The `.env` `GEMINI_API_KEY` is a **free-tier** key. A live baseline is
6 back-to-back multi-thousand-token repair conversations; the free tier's
per-minute + per-day quota throttles that hard.

What the run actually observed (real numbers, not fabricated):

| case | outcome | tokens | note |
|------|---------|--------|------|
| bad_adc_divider | **FIXED** | 34025 | genuine live repair through the gate |
| i2c_without_pullups | provider_error | 3425 | model engaged, then 429 rate-limit |
| invalid_pin_function | provider_error | 7015 | model engaged, then 429 rate-limit |
| missing_ground | provider_error | 0 | 429 before any tokens |
| overloaded_3v3_rail | provider_error | 0 | 429 before any tokens |
| phase3_failure | provider_error | 0 | 429 before any tokens |

`provider_error` is a DISTINCT loop stop reason (added for exactly this): a
rate-limit is a quota problem, not the model failing to fix. The committed number
is therefore **1/6 fixed, 5/6 rate-limited** — below the ≥4/6 target, but the
misses are quota, not capability. Evidence the mechanism works when a call gets
through:

- `bad_adc_divider` was fixed live end-to-end (34025 tokens, one gated patch).
- `missing_ground` was **also fixed live in isolation** (single-case run, 14469
  tokens, correct ground-net + GND-pin patch through the gate) — it only shows
  `provider_error` above because it ran 4th, after the quota was spent.
- Two more cases (`i2c_without_pullups`, `invalid_pin_function`) got real token
  usage before the 429, i.e. the model was actively producing a patch.

So the loop drives a real provider to a real gated fix; a full unattended 6-case
baseline needs quota headroom the free tier does not give in one sitting.

### Maintainer checklist — completing the live baseline

To land a full ≥4/6 baseline, run with a **paid** key (or a key with fresh daily
quota) so the run is not rate-limited:

```sh
cd packages/agent
# Gemini (paid tier recommended); throttle to respect per-minute limits:
npm run bench -- --provider gemini --case-delay-ms 20000 --provider-error-retries 3 --retry-cooldown-ms 60000
# or Anthropic if a key is available:
npm run bench -- --provider anthropic --model claude-sonnet-5
```

The runner writes `bench/results/<date>-<provider>.json`; commit it. If the loop
scores below the ≥4/6 target with a NON-rate-limited key, that is a genuine P0
quality finding — document the per-case deltas on issue #19 (the runner already
records `stopReason` + tokens per case to make the diff obvious). Single cases can
be isolated with `--only <name>` (e.g. `--only missing_ground`) to debug a
specific failure without spending quota on the whole set.

The key never enters the repo — it is read from the environment / `.env` for a
local run only (AGENTS.md rule 15).
