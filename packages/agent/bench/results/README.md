# Repair benchmark — live baseline results

Each `YYYY-MM-DD-<provider>.json` is the scored output of a live repair-benchmark
run (`npm run bench -- --provider <provider>`), committed so repair quality is
tracked over time (issue #19 deliverable 4). The mock benchmark that validates
the loop **mechanics** runs in CI (`tests/repair/bench.test.ts`, 6/6 fixed) and
is not committed here — only live runs are.

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

## 2026-07-05 — OpenAI (`2026-07-05-openai.json`)

**Honest status: BLOCKED — the OpenAI key has no billing quota
(`insufficient_quota`), NOT a model-quality or loop failure.** This run was an
attempt to complete #19's ≥4/6 target with a paid OpenAI key after the Gemini
free-tier key was quota-exhausted. The intended model was **`gpt-4o`** (a
capable tool-use model, forced via `--model gpt-4o` — the provider's default is
`gpt-4o-mini`, which we deliberately did not use).

What the run actually observed (real numbers, not fabricated):

| case | outcome | tokens | note |
|------|---------|--------|------|
| bad_adc_divider | provider_error | 0 | 429 `insufficient_quota` before any tokens |
| i2c_without_pullups | provider_error | 0 | 429 `insufficient_quota` before any tokens |
| invalid_pin_function | provider_error | 0 | 429 `insufficient_quota` before any tokens |
| missing_ground | provider_error | 0 | 429 `insufficient_quota` before any tokens |
| overloaded_3v3_rail | provider_error | 0 | 429 `insufficient_quota` before any tokens |
| phase3_failure | provider_error | 0 | 429 `insufficient_quota` before any tokens |

Committed number: **0/6 fixed, 6/6 quota-blocked** — every case failed at the
FIRST chat-completions call with **zero tokens spent**, which is the fingerprint
of a billing/quota block, not the model failing to fix.

Root cause (probed directly, key redacted):
- `GET /v1/models/gpt-4o` → **200** (the key authenticates and the model is
  listed — this is the "probe works" signal, but a GET does not consume quota).
- `POST /v1/chat/completions` (gpt-4o AND gpt-4o-mini) → **429** with body
  `{"type":"insufficient_quota","code":"insufficient_quota","message":"You
  exceeded your current quota, please check your plan and billing details."}`.
- No `retry-after` / `x-ratelimit-*` headers — this is account billing
  exhaustion, not a transient per-minute rate-limit, so the loop's
  provider-error retries cannot recover it.

`provider_error` is the DISTINCT loop stop reason for exactly this (auth / quota
/ network) — it is not scored as the model failing to repair. As with the Gemini
disclosure above, the misses here are a quota problem, not capability: no chat
call ever reached the model, so this run says **nothing** about gpt-4o's repair
quality. The ≥4/6 target remains OPEN pending a funded OpenAI key (or an
Anthropic key).

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
