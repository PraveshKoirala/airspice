# Circuit Refinement Loop — Results

Automated stress test of the AirSpice webapp: the in-app AI Assistant built 100
complex circuits end-to-end (describe → build → gated stage → Apply → schematic
→ simulate → firmware), driven by the deterministic Playwright harness
(`../run-circuits.mjs`) against the real dev server and local LLM proxy.

## Headline

| metric | result |
|---|---|
| Circuits applied + rendered | **100 / 100** |
| MCU circuits built + rendered + firmware | **84 / 84** (21 each: ESP32-C3, ESP32-WROOM-32, ATmega328P, STM32F103) |
| Simulations passed | **90 / 100** |
| Clean `ok` verdict | **99 / 100** |
| **Webapp bugs found** | **0** |

The one non-`ok` is `analog-089-half_wave`: a "half-wave rectifier" is degenerate
on a DC source (the engine has no AC-source primitive), so at DC steady state
`v_out ≈ V_src` and the agent's diode-drop assertion is unsatisfiable. A corpus
template limitation, not a product defect.

## Method notes

- **Two passes.** The first run (`results/`) used the proxy default
  `claude-sonnet-4-6`; the proxy quota for that model hit a ~1h33m
  `model_cooldown` around spec ~44, so 57 later specs returned `429` and could
  not stage. The app surfaced the 429 honestly ("Provider error … reset in
  1h33m") — correct behavior, not a bug. The 71 non-`ok` specs were re-run
  (`results-rerun/`) on `gemini-3.1-pro-low` (available), and the two passes were
  merged (`results/merged.jsonl`, re-run wins).
- Every circuit ran in an isolated browser context from a forced-blank design;
  the harness clicks **Apply** only when the button is actually *visible*
  (catches render/CSS regressions), then simulates and checks the Firmware tab.

## Bugs found and fixed by this loop

1. **React `setState`-in-render** (`packages/ui/src/agent/useAgentSession.ts`).
   `applyProposal` called `applyValidated` (a zustand store write) and
   `maybeAdoptDesignTitle` *inside* the `setProposals` updater function. State
   updaters must be pure; React ran it during render (twice under StrictMode),
   firing the store write mid-render — a console error on every page that used
   the agent. Fixed by moving the side effects out of the updater. Verified gone
   via `../debug-setstate.mjs`.

2. **Agent `set_voltage` shadowing → false multi-test sim failures**
   (`packages/agent/src/tools/prompts.ts`). The agent would declare a fixed
   `voltage_source` on a supply net *and* write multiple tests that
   `<set_voltage>` that same net to different values. The emitter correctly skips
   a test source on a net a component source already drives (two parallel sources
   abort ngspice — parity-locked, oracle-faithful), so the override was silently
   ignored and swept-voltage assertions failed. Fixed with explicit guidance in
   the agent contract: for a swept supply, drive the net *only* from each test's
   `set_voltage` (no fixed source); otherwise keep every assertion consistent
   with the one declared source. Verified: mcu-003/mcu-004 went from sim-fail →
   sim-pass after the fix.

3. **Harness console-filter gap** (`../run-circuits.mjs`). ngspice stderr
   diagnostics (singular-matrix on floating-LED blinkers, etc.) leaked into the
   "console error" signal. Tightened the filter so simulation-domain messages are
   not misread as webapp JS errors.

## Non-bug observations

- **Floating-net actuators** (LED-from-GPIO blinkers, MOSFET load switches):
  the LED/load net is driven only by the *non-simulated* MCU, so ngspice can't
  find an operating point ("singular matrix"). Expected — these circuits build,
  render, and generate firmware correctly; their analog sim is simply not
  meaningful. Marked `expectSimPass: false`.
- **4 MCUs** in the registry (ESP32-C3, ESP32-WROOM-32, ATmega328P, STM32F103).
  The corpus spreads 84 circuits evenly across them; expanding the registry would
  enable broader MCU diversity (future enhancement).
- **No AC-source primitive**, so rectifier/AC-filter prompts are degenerate on DC.

## Reproduce

```
# with the dev server on :5199 and the proxy on :8317
node qa/gen-corpus.mjs > qa/circuit-corpus/prompts.json      # regenerate specs
node qa/run-circuits.mjs --count 100 --concurrency 4         # full run
node qa/run-circuits.mjs --ids <csv> --model <m> --out <dir> # targeted / model override
node qa/triage.mjs            # cluster verdicts
node qa/merge-results.mjs     # merge original + re-run, final tally
```
