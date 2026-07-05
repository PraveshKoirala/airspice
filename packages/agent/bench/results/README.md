# Benchmark — live baseline results

Two benchmarks live here:

* **Repair bench** (`YYYY-MM-DD-<provider>.json`) — the scored output of a live
  repair-benchmark run (`npm run bench -- --provider <provider>`), issue #19.
* **Build bench** (`build-YYYY-MM-DD-<provider>.json`) — the scored output of a
  live build-benchmark run (`npm run build-bench -- --provider <provider>`),
  issue #107. Generative half of the pitch: the agent builds a circuit from a
  natural-language device spec and an OBJECTIVE Python scorer (`air.build_score`)
  checks it — real ngspice on `sim_assertion`, deterministic constraint solver on
  connectivity, ERC via `air.validation`. No LLM judge anywhere.

The mock benchmarks that validate the loop **mechanics** run in CI
(`tests/repair/bench.test.ts` for repair, `tests/build/bench.test.ts` for build)
and are not committed here — only live runs are.

## 2026-07-05 — Build bench — Anthropic `claude-sonnet-5` — SMOKE (issue #107)

**Headline: 0/2 built in the post-cap smoke; per-spec token cost 30k–40k tokens.**
This is a small live SMOKE against a subset of the 36-spec corpus, not a full-36
run — that spend is orchestrator-gated. The purpose here is to (a) prove the
harness works end to end live, (b) calibrate the per-spec token cost so the
full-36 estimate is grounded, and (c) surface honest per-spec failure modes.

### Pre-cap run (evidence): `build-2026-07-05-anthropic-precap.json`

The first live smoke (5 specs) hit an uncapped-budget bug: each build-loop
iteration called `runConversation` with the default `BudgetLimits` (12 provider
turns × 200,000 tokens), so one spec burned 267k tokens over 3 build iterations.
Kept in the repo as evidence of the pre-fix behaviour and the model field
`null` bug. Totals: 5 specs / 0 built / 674,678 tokens (≈ $1.50 blended at
Sonnet 5 pricing).

### Post-cap run (headline): `build-2026-07-05-anthropic.json`

The fixes committed with this run:

* **Per-iteration budget cap** in the build loop
  (`BUILD_ITER_BUDGET = {maxIterations: 4, maxTokens: 24_000, maxWallMs: 60_000}`)
  overriding the runner's default. Multiplied by `turn_budget` (default 4) this
  is the per-spec worst case: 4 iters × 24k = 96k tokens.
* **Belt-and-suspenders `perSpecTokenCap`** (CLI: `--per-spec-token-cap`) — the
  loop stops with distinct reason `token_cap` if the cumulative crosses it.
  Guarantees a bounded live spend across build iterations.
* **`model` field recorded correctly** — the runner probes
  `provider.defaultModel` when `--model` is omitted (was `null` before).
* **Hardened scorer path** — a scorer-subprocess failure now returns a scored
  non-build with the reason instead of a bubbled `scorer_error`. The Python CLI
  also wraps `score_build` in try/except so a Python exception on the AGENT'S
  design becomes `failed_criterion: "scorer_exception"`, not a lost `0`.
* **Per-iteration diagnostic log** (`iterations_log` in the results JSON) — tool
  names called, tokens, staged y/n, `progressed`, `conversationReason`, scorer
  verdict. This is what makes future no_progress / no_build debuggable without a
  live re-run.

Run: `npm run build-bench -- --provider anthropic --per-spec-token-cap 40000
--only led_esp32c3_single,adc_esp32c3_lipo_divider`. The `.env` supplies the
funded `ANTHROPIC_API_KEY`; the key is never in the repo.

| spec | outcome | turns | tokens | note |
|---|---|---|---|---|
| adc_esp32c3_lipo_divider | not built (`no_build`) | 1 | 29,649 | agent explored (`list_registry`, `validate`, `run_simulation`) but hit the 4-turn conversation cap before staging any design |
| led_esp32c3_single | not built (`token_cap`, failed `firmware_intent`) | 2 | 50,056 | agent staged a structurally-correct LED circuit both iterations; scorer failed `write_gpio expected a GPIO op on net 'led_gpio'; op-nets=set()` — the agent's `<write_gpio binding="bind_led"/>` form uses a binding attribute, the scorer (#106) looks for `pin="..."` |

**Totals:** 0/2 built, 79,705 tokens across the run (≈ $0.24 blended at Sonnet 5
introductory pricing). The 40k per-spec cap held (led hit it and stopped; adc
finished well under it).

### What the log tells us (per-spec honest diagnosis)

* **adc_esp32c3_lipo_divider** — the agent burned its 4-turn conversation cap
  exploring (`list_registry_components → validate_design ×2 → run_simulation`)
  and never called `set_design`. Two possible fixes: raise
  `BUILD_ITER_BUDGET.maxIterations` from 4 → 6, and/or tune the Building system
  prompt to push earlier commitment. Raising the cap is orchestrator-gated (more
  spend); prompt tuning is a follow-up issue.
* **led_esp32c3_single** — the agent's structural design is *correct* (see the
  saved design: MCU→R→LED_anode→cathode→gnd with `function="GPIO_OUT"` on the
  right pin), but the firmware task uses the binding-based
  `<write_gpio binding="bind_led"/>` form. The #106 scorer's
  `check_firmware_intent` only reads `op.get("pin")`, so it misses the binding
  form. This is a real scorer/corpus coupling to document — the agent got the
  circuit right; the scorer's `write_gpio` matcher is narrower than AIR's
  grammar allows. Widening the scorer is a #107 follow-up (would need re-running
  the golden suite to prove no regressions).

### Calibrated per-spec cost + full-36 estimate

Per-spec observed (post-cap): 30k–50k tokens. Per-spec ceiling under the caps:
`turn_budget (4) × maxIterations (4) × maxTokens (24k)` = 384k tokens absolute
worst case (~$0.80/spec at Sonnet 5). Realistic per-spec average from this
smoke: ~40k tokens ≈ $0.12 blended.

**Full-36 estimate under the current caps:**
- Realistic (2 specs' average × 36): ~1.4M tokens ≈ **$4.30**
- Absolute worst case (per-spec ceiling × 36): ~13.8M tokens ≈ **$29** (would
  need the `perSpecTokenCap` disabled AND every spec spinning to the max).
- Recommended full-36 run guard: `--per-spec-token-cap 50000` → hard cap of
  1.8M tokens ≈ **$5.40 max**.

### Honest note on 0/2

Two live specs is not enough to draw a capability conclusion about
`claude-sonnet-5` on generative building. Both failures are *close-call* signals
(one over-exploration, one grammar-form mismatch), NOT a capability collapse.
The pitch — generative building is HARDER than repair — appears to hold, but the
2-spec sample size is too small to headline. The value of THIS run is (a) the
per-iteration budget bug fixed so the tool can't blow through hundreds of
thousands of tokens again, (b) the diagnostic logging that made both failures
readable without a live re-run, and (c) the calibrated cost estimate.

## 2026-07-05 — Anthropic `claude-sonnet-5` (`2026-07-05-anthropic.json`) — HEADLINE

## 2026-07-05 — Anthropic `claude-sonnet-5` (`2026-07-05-anthropic.json`) — HEADLINE

**Headline: 6/6 broken circuits autonomously fixed by `claude-sonnet-5`** — a
clean sweep, above the ≥4/6 target from issue #19. This is the **post-#102-fix**
baseline: it re-runs the full 6-case set on `main` after the multi-tool-call
conversation-reconstruction bug (#101, fixed in #102) landed, and supersedes the
earlier 5/6 result (which missed `i2c_without_pullups` on that provider defect,
not on model quality). A funded Anthropic key drove the full 6-case set end to
end (`npm run bench -- --provider anthropic --model claude-sonnet-5
--max-iterations 5`); every fix went through the real air-ts gate. Every one of
the 6 fixes converged in a **single iteration**.

| case | outcome | iters | tokens | note |
|------|---------|-------|--------|------|
| bad_adc_divider | **FIXED** | 1 | 12978 | gated patch, first try |
| i2c_without_pullups | **FIXED** | 1 | 73972 | multi-tool-call fix now works post-#102 (was the 5/6 miss) |
| invalid_pin_function | **FIXED** | 1 | 16527 | gated patch, first try |
| missing_ground | **FIXED** | 1 | 11132 | gated patch, first try |
| overloaded_3v3_rail | **FIXED** | 1 | 11633 | gated patch, first try |
| phase3_failure | **FIXED** | 1 | 21259 | gated patch, first try |

**Totals:** 6/6 fixed, 147,501 tokens across the run. At `claude-sonnet-5`
introductory pricing ($2 in / $10 out per MTok through 2026-08-31), the whole
6-case run cost **≈ $0.30–0.40** (repair turns are input-heavy: a large design +
diagnostics context per turn, a small patch out; the absolute floor if every
token were billed at the input rate is ≈ $0.30, the ceiling at the output rate is
≈ $1.48). `i2c_without_pullups` dominates the token count (~74k) because its fix
is a genuine **two-tool-call** turn (a pull-up for SDA and one for SCL) — exactly
the multi-tool-call shape that used to trip the #101 bug.

### The prior 5/6 miss is now fixed — #102 confirmed

The earlier baseline missed `i2c_without_pullups` with a generic
`provider_error`. The captured underlying error was a 400 from Anthropic's
`/v1/messages`:

```
Provider returned 400: invalid_request_error —
messages.0.content.1: unexpected `tool_use_id` found in `tool_result` blocks:
toolu_...  Each `tool_result` block must have a corresponding `tool_use` block
in the previous message.
```

Root cause (fixed in #102): this case's fix needs **two** `propose_patch` tool
calls in one turn. The conversation runner used to reconstruct the assistant
message as plain text (dropping the `tool_use` blocks), then send `tool_result`
blocks referencing `tool_use_id`s with no matching `tool_use`, which Anthropic
rejects. #102 (`#101: Preserve tool_use blocks in multi-tool-call conversation
reconstruction`) carries the assistant turn's `tool_use` blocks into the message
history. **This run confirms the fix**: `i2c_without_pullups` now drives its
two-tool-call fix through the real gate and validates clean in a single
iteration, taking the baseline from 5/6 to **6/6**. No case regressed.

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
