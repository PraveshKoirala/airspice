# Simulation Spec v0.1

`air simulate` validates the XML, compiles the selected profile, runs ngspice
when available, and writes structured reports to `generated/reports`.

When ngspice is unavailable, the MVP uses a deterministic DC fallback for
supported passive divider assertions.

Supported assertions:

- `assert_voltage net="..." min="..." max="..."`
- `assert_current component="..." min="..." max="..."`

Reports are structured JSON and suitable for `air repair-context`.

Each report includes:

- `measurements`: final value per signal.
- `measurement_stats`: final/min/max/time-of-min/time-of-max per signal.
- `diagnostics`: assertion failures, compiler diagnostics, and simulation
  failures (see below).
- `status`: `passed` or `failed`.
- `backend`: which engine produced the numbers (see below).

ngspice CSV output is parsed when available. If ngspice is not installed, the
deterministic fallback supports voltage sources, resistor dividers, ideal LDO
outputs, generic load currents, and current/load-step setup values.

## PWM stimulus duty semantics

A firmware task's periodic `write_gpio high` + `delay ton` compiles to a SPICE
`PULSE(0 A 0 TR TF PW PER)`. Because that trapezoid is high across `PW+(TR+TF)/2`,
the plateau is emitted **ramp-area-compensated** as `PW = ton − (TR+TF)/2` (with
`TR = TF = 1 µs`), so the effective duty equals the intended `ton/period` at any
frequency (issue #59). Degenerate cases are guarded: `ton ≤ 0` → `DC 0`,
`ton ≥ period` → `DC A`, and a sub-edge `ton ≤ 1 µs` collapses the plateau
(`PW = 0`) and shrinks the edges to `ton` so the triangle area still preserves the
duty.

## Backend / failure semantics

A report's `backend` field records how the numbers were produced, and the three
cases are kept strictly distinct so a simulation that never ran can never look
like one that passed a real transient:

- `ngspice` — ngspice ran (exit 0) and its transient produced readable waveform
  data. `status` reflects the assertions.
- `builtin_dc_fallback` — no ngspice binary was reachable, so the deterministic
  DC solver produced the numbers. This is the **only** legitimate fallback: it
  is triggered solely by ngspice being *not installed*, never by an ngspice
  failure. `status` reflects the assertions; nothing failed. The report carries
  an actionable `NGSPICE_NOT_FOUND` **info** diagnostic (domain `analog`) with
  install guidance, so the degradation is visible without being an error.
- `ngspice_failed` — ngspice ran and exited **non-zero** (e.g. the netlist
  references a `.model`/`.subckt` that is not defined, so ngspice writes
  "unknown model" / "no simulations run" and exits 1). This is a hard
  simulation failure. The report `status` is `failed` and a structured
  `NGSPICE_FAILED` diagnostic (domain `simulation`) carries the ngspice exit
  code (`observed.returncode`) and the tail of ngspice's output identifying the
  cause (`observed.stderr_tail`). A non-zero ngspice exit is **never** silently
  downgraded to a clean `builtin_dc_fallback` `passed` report.

Note that most designs that would produce an undefined-model netlist are caught
*earlier*, at validation: a component whose `spice_model`/`spice_subckt` names a
part the compiler cannot back with a definition raises the `UNDEFINED_SPICE_MODEL`
error, which blocks compilation before ngspice is ever invoked. The
`ngspice_failed` path is the backstop for any ngspice failure that slips past
validation.
