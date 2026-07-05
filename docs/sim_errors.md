# Simulation error mapping (sim-wasm)

ngspice reports failures as free-text lines on **stderr**. `packages/sim-wasm`
turns the common, actionable ones into stable, matchable `SimDiagnostic` codes
with a human hint, so the UI and the report pipeline (#14) can react
programmatically instead of string-scanning raw output.

Two invariants (issue #13 guardrails):

- **stderr is never swallowed.** Every ngspice stderr line reaches the client as
  a `stderr` event, *in addition to* any structured diagnostic. The classifier
  in `src/diagnostics.ts` is a classifier, not a filter.
- **Unknown failures still fail.** A stderr blob that contains an error marker
  but matches no rule is surfaced as `SIM-UNKNOWN` (never silently passed), so a
  new failure mode is visible and can be added to the table below.

## Error table

Each row has a stable `code`, the ngspice text it matches, the hint the client
shows, and the reproducing netlist used by the tests. Synthetic-string mapping
is unit-tested in `tests/unit/diagnostics.test.ts`; the real-engine path (feed
the netlist, assert an error diagnostic + streamed stderr) is in
`tests/browser/errors.spec.ts`.

| Code | Triggered by (ngspice stderr, case-insensitive) | Hint | Reproducing netlist |
|---|---|---|---|
| `SIM-SINGULAR-MATRIX` | `singular matrix`, `matrix is singular` | A node has no DC path to ground, or two ideal sources conflict — add a resistor to ground on the floating node, or fix a shorted/duplicated source. | A current source into a node with no DC return path (`I1 b c 1m` with `c` floating). |
| `SIM-TIMESTEP-TOO-SMALL` | `timestep too small` | A discontinuity or stiff/under-damped node — add series R or a snubber, soften step sources (finite rise/fall), or relax reltol; check the named node. | An ideal step into an LC tank with no damping. |
| `SIM-UNKNOWN-DEVICE` | `unknown device`, `unrecognized device`, `unknown subckt` | Check the device prefix (R/C/L/V/I/M/Q/D…) and that any `.model`/`.subckt` it needs is defined before use. | A device with an unknown prefix letter (`Z1 a 0 bogus`). |
| `SIM-MODEL-NOT-FOUND` | `unable to find definition of model`, `can't find … model`, `model … not found` | Add the missing `.model <name> <type>(…)`, or fix the model name on the device. | `M1 d g 0 0 MISSINGMODEL` with no matching `.model`. |
| `SIM-GND-MISSING` | `does not have a ground`, `no ground`, `ground node … not` | Every ngspice circuit needs node `0` as ground — connect a net to `0`. | A circuit whose nodes never reference node `0`. |
| `SIM-PARSE-ERROR` | `parse error`, `error on line`, `unknown parameter`, `syntax error`, `bad syntax` | Check the named line for a typo, bad unit, or missing token. | A malformed component line (`R1 a b` — missing value). |
| `SIM-GMIN-STEPPING-FAILED` | `gmin stepping failed`, `source stepping failed`, `no convergence in … dc` | Provide `.nodeset`/`.ic` hints, add gmin, or check for a positive-feedback loop with no stable operating point. | A latch/positive-feedback pair with no `.ic`. |
| `SIM-UNKNOWN` | any line with an error marker (`error`, `fatal`, `aborted`, `cannot`, `could not`, `unable to`) that matched no rule above | See the raw output; if common, add a rule in `diagnostics.ts`. | (fallback — no fixed netlist) |

### Engine/transport codes (not from ngspice stderr)

These are produced by the worker/client transport, not ngspice, and complete the
error surface:

| Code | Meaning |
|---|---|
| `SIM-ENGINE-LOAD-FAILED` | The WASM engine chunk failed to fetch/instantiate in the worker. |
| `SIM-RUN-THREW` | `runSim` threw before producing a result and the throw matched no ngspice rule. |
| `SIM-CANCELED` | The run was canceled by the client (worker terminated + respawned; ADR 0011). |
| `SIM-WORKER-CRASH` | The worker emitted an uncaught `error` event mid-run. |
| `SIM-ENGINE-FATAL` | The engine reported a fatal during startup (`fatal` message). |

## Notes

- ngspice always prints two benign lines on startup
  (`can't find the initialization file spinit`, `Using SPARSE 1.3 …`). These are
  matched by a benign-line filter and never produce an error diagnostic — but
  they are still streamed as `stderr`/`stdout` events like everything else.
- Rules are tried in array order; the **first** match wins and codes are
  de-duplicated, so a given stderr blob always maps to the same code across runs
  and platforms (determinism, AGENTS.md rule 10).
- To add a failure: add a `Rule` to `RULES` in `src/diagnostics.ts`, a
  synthetic-string case to `tests/unit/diagnostics.test.ts`, a reproducing
  netlist to `tests/browser/errors.spec.ts`, and a row here.
