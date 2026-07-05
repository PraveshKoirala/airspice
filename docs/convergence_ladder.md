# Convergence-aid ladder

> Issue #45. Oracle-first (ADR 0009): this behaviour lands in the Python oracle
> (`packages/core/src/air/simulator.py`) first; the identical ladder is ported
> to the browser pipeline when #14's report pipeline exists (see "Browser-side"
> below). All manual citations are to the **ngspice-46 user manual** (the local
> reference build); the same options and ordering exist unchanged in the
> CI-pinned ngspice 42 manual.

## Why this exists

Real SPICE fails to converge on *legitimate* circuits — floating regions,
stiff switching stages, bistables that need an operating-point nudge. On a raw
run that surfaces as a jargon error ("singular matrix", "no convergence",
"Time step too small"). Two consumers are harmed:

- **Users** get an engine error with no recourse and no idea their design is
  actually fine.
- **The repair agent (#19)** misreads a *numerical* non-convergence as a
  *design* defect and "fixes" a working circuit — the worst possible outcome
  for trust.

The remedy is exactly what an experienced SPICE user does by hand — try the
documented convergence aids in a fixed order — made **deterministic and
automatic**. The ladder is FIXED and FINITE (max 4 rungs, no randomness, no
per-circuit tuning tables): determinism (AGENTS.md rule 10) outranks cleverness.

## What ngspice already does on its own (and why the ladder is still needed)

Per **ngspice-46 manual §11.3.5 (`.OP`)**, when an initial DC solution is hard
ngspice *already* applies convergence aids **in order**: (1) gmin stepping
(`gminsteps`), (2) source stepping (`srcsteps`), (3) an optional transient
operating point. DC analysis "is complete as soon as one successful step is
found". Modern ngspice (46) is therefore very robust — its default transient-op
aid rescues many topologies that older builds abort on.

So the ladder does **not** re-invent gmin/source stepping. It:

1. Runs the design **exactly as the compiler emits it** first, always (rung 1) —
   so parity with a hand-run ngspice is preserved and an already-converging
   design's numbers never change.
2. When rung 1 does not converge, **escalates the documented aids beyond their
   defaults** and, at the top of the ladder, **changes the integration method
   and relaxes one tolerance one notch** — the moves a human makes when the
   defaults are not enough — while **recording every attempt** so the loss of
   as-written fidelity is never silent.

A "does not converge" signal is: ngspice exits non-zero, **or** ngspice runs but
the transient produces no readable data (the run was aborted mid-analysis). Both
mean "the numbers we would report did not come from a completed transient".

## The ladder (ordered, deterministic, max 4 rungs)

Each rung's `.options` are **added to** the compiler's netlist (they never
remove the base `.options filetype=ascii`). The ladder stops at the first rung
that converges. Rung 1 is always the unmodified deck.

| Rung | Name | `.options` added (verbatim) | ngspice-manual basis |
|---|---|---|---|
| 1 | **as-written** | *(none — the compiler's netlist unmodified)* | Baseline. ngspice's own default aids (gmin→source→transient-op) run here, in the order fixed by **§11.3.5**. Parity requirement: an already-converging design MUST be solved here so its measurements are byte-for-byte the hand-run values (AGENTS.md rule 3). |
| 2 | **gmin stepping (escalated) + more DC iterations** | `.options gminsteps=1 itl1=500` | **§11.1.2**: `GMINSTEPS=x` "sets the number of Gmin steps to be attempted … gmin stepping is tried before … source stepping"; `ITL1=x` "resets the dc iteration limit. The default is 100." Rung 2 keeps gmin stepping explicitly on and quintuples the DC Newton-iteration budget (100→500) so a near-singular operating point that was one refinement short at the default limit can settle. Gmin stepping is the *first* documented aid (§11.3.5 step 1), so it is the first escalation. Purely an operating-point aid: it inserts small conductances across active devices and does not alter the reported topology. |
| 3 | **source stepping (escalated) + ramp** | `.options srcsteps=10 gminsteps=1 itl1=500` | **§11.1.4 / §11.3.5**: `SRCSTEPS=x` "a non-zero value causes SPICE to use a source-stepping method to find the DC operating point. The value specifies the number of steps" (source stepping "sets all supply voltages and currents to zero, then ramps them up … to 100%"). Source stepping is the *second* documented aid (§11.3.5 step 2), so it is the second escalation; 10 steps ramps the supplies in finer increments than the default for stiff bias networks and bistables that snap. Rung 3 keeps rung 2's gmin/iteration escalation in place (aids compose). Still an operating-point aid — no accuracy trade-off in the reported transient. |
| 4 | **Gear integration + one-notch relaxed reltol + transient iteration budget** | `.options method=gear reltol=0.005 srcsteps=10 gminsteps=1 itl1=500 itl4=100` | **§11.1.4**: `METHOD=name` "sets the numerical integration method … 'Gear' or 'trapezoidal' … The default is trapezoidal" — Gear (a stiff-stable implicit method) tames the *transient* non-convergence ("Time step too small") that stiff/switching circuits hit under the default trapezoidal rule. **§11.1.2**: `RELTOL=x` "resets the relative error tolerance … The default value is 0.001 (0.1%)"; rung 4 relaxes it **exactly one notch** to 0.005 (0.5%). **§11.1.4**: `ITL4=x` "resets the transient analysis time-point iteration limit. The default is 10" — raised to 100 so a hard timepoint gets more Newton iterations before the step is rejected. This is the ONLY rung that trades accuracy, and the report says so (see below). |

Rationale for the order (all from the manual, no heuristics):

- Rungs 2→3 walk ngspice's own documented aid sequence (**§11.3.5**: gmin
  stepping *then* source stepping), escalating each beyond its default before
  moving on. We escalate the cheaper/earlier aid first.
- Rung 4 is last because it is the only rung that changes the answer's
  character: `method=gear` changes the integration rule and `reltol=0.005`
  loosens the accuracy target. **Relaxing tolerance is rung 4, never rung 1** —
  silent accuracy loss is the failure mode this issue exists to prevent, so it
  is the last resort and it is always reported.

### What the ladder deliberately does NOT do

- No randomized elements, no adaptive search, no per-circuit tuning table — the
  four rungs above are the entire universe of retries (guardrail: determinism).
- Rung-2+ options are **never** blanket-applied to a first run. As-written is
  always rung 1, or parity with hand-run ngspice breaks and an already-passing
  corpus fixture's measurements would change.
- It does not touch `rshunt`/`rseries`/`cshunt` (**§11.1.2.1**): those are
  XSPICE-gated and *rewrite the circuit* (add resistors/capacitors to every
  node), which would change the reported numbers of a design that converges
  fine without them — the opposite of "as-written first". They remain a
  documented manual remedy a user can add by hand, not an automatic rung.

## The `convergence` report section

Every analog report gains a `convergence` object (JSON, keys sorted, so it slots
deterministically into the existing report structure between `backend` and
`diagnostics`):

```json
"convergence": {
  "attempts": [
    {"rung": 1, "name": "as-written", "options": [], "converged": true}
  ],
  "converged": true,
  "rung": 1,
  "aids_required": false,
  "terminal": false,
  "note": null
}
```

Fields:

- `attempts` — ordered list of every rung tried, each with `rung` (1-4), `name`,
  the exact extra `.options` tokens for that rung (`options`), and whether it
  `converged`. An already-converging design has exactly one attempt (rung 1).
- `converged` — did any rung converge.
- `rung` — the 1-based rung that produced the reported numbers (null if none).
- `aids_required` — `true` when the reported numbers came from rung ≥ 2. This is
  the flag the UI (#14/#25) turns into the dismissible note and the flag the
  repair agent (#19) reads to know **"rung ≥ 2 success is NOT a design defect"**.
- `terminal` — `true` when the ladder was exhausted without converging.
- `note` — a human string when `aids_required` (rung ≥ 2) or `terminal`:
  - rung ≥ 2 success: `"numerical aids required (rung N: <name>); accuracy may
    be reduced — see docs/convergence_ladder.md"`. Rung 4 additionally states
    tolerance was relaxed.
  - terminal: a **topology-directed** remediation hint (check for floating
    nodes / a missing DC path to ground), NOT the raw ngspice stderr.

### UX semantics (report-field level; rendering is #14/#25)

- A result computed on **rung ≥ 2** carries `aids_required: true` and the `note`
  above, so the surface can show a visible, dismissible "numerical aids were
  required; accuracy may be reduced" banner (issue AC 4).
- A **terminal** failure emits the new diagnostic `SIM-010` (below) whose
  message is a topology-directed remediation hint, never raw stderr (issue
  AC 4). The existing `NGSPICE_FAILED` diagnostic still fires for the underlying
  non-zero exit so the exit code / stderr tail are preserved for debugging.

### Agent-context wiring (report fields only; consumption is #18/#19)

`run_simulation` / `run_design_check` already return the full report tree
(`simulation.reports[*]`), so the new `convergence` section flows to the agent
unchanged. #19's repair loop reads:

- `convergence.aids_required == true` → the design is fine; a numerical aid was
  needed. **Do not propose a value/topology repair for a convergence aid.**
- `convergence.terminal == true` → inspect **topology before values** (floating
  nodes, missing ground path), per the `SIM-010` remediation.

This PR implements the **report fields**; the prompt/loop consumption is #18/#19
and is coordinated on those issues.

## New diagnostic code

Per the diagnostics law (#44, docs/diagnostics_spec.md) new codes use the
namespaced scheme. Simulation codes use the `SIM-` prefix (#13). This issue mints:

- **`SIM-010`** — *terminal convergence failure*. Severity `error`, namespace
  `simulation`, owner `simulator`. Emitted when the ladder is exhausted without
  convergence. Message is a topology-directed remediation hint; `remediation`
  points at floating-node / ground-path inspection. Registered in
  `registry/diagnostics.json` and rendered via the registry loader
  (`render_message`), so message and registry cannot drift.

(`NGSPICE_FAILED` remains the grandfathered code carrying the raw exit
code/stderr tail; `SIM-010` is the user/agent-facing terminal-convergence
diagnostic layered on top.)

## Corpus impact (oracle-first)

Adding the `convergence` section changes every golden-corpus report JSON that
has a `report/` (5 designs today). The change is **purely additive**: the new
`convergence` key appears; **every measurement, measurement_stat, waveform and
existing diagnostic is unchanged** because every corpus design converges on
rung 1 (`aids_required: false`, one attempt). The corpus is regenerated by the
CI `corpus.yml` artifact (ngspice 42 pin), never by hand.

## Browser-side (deferred to #14, honest scoping)

The issue's acceptance criteria include "identical implementation in both
engines" and screenshots of the UI note. The browser report pipeline is #14 and
does **not exist yet** in this tree (there is no `packages/air-ts` simulation
report path to carry a `convergence` section, and the UI note surface is
#14/#25). This PR therefore delivers:

- the **full ladder design** (this document), and
- the **oracle-side implementation** (simulator.py + corpus + the diagnostic +
  the report fields the agent/UI consume).

The air-ts/browser port of the identical ladder, the parity job coverage of the
new `convergence` section (#15), and the UI note + terminal-failure rendering
land when #14 exists. This is coordinated on issue #45.
