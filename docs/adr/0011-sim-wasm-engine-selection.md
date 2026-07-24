# ADR 0011: sim-wasm engine selection (ngspice → WASM) — adopt eecircuit for analog; control deferred to #88

## Status

**Accepted (SPLIT decision)** (2026-07-05)

This ADR records the evaluation required by issue #13 and epic #12 binding decision 5.
The evaluation found that **neither available path satisfies the hard requirement
(mid-transient halt / alter / resume) under the epic's binding constraints
(worker-only + single-threaded WASM + no SharedArrayBuffer/COOP+COEP)** — evidence
below. That was escalated as a P0 (issue #13) and the **epic owner accepted it and
split the issue** (ruling: issue #13 comment 4885120883):

1. **Adopt `eecircuit-engine`** (MIT, ngspice 45.2) wrapped behind our typed,
   worker-only protocol for **fire-and-forget analog simulation** — all that M2
   (#14/#15/#25), M3, and M4–M7 require. The engine advertises
   `capabilities.control = false` (see `packages/sim-wasm/src/protocol.ts`).
2. **Defer the control-capable engine** (halt/alter/resume) to a dedicated
   single-threaded `--with-ngshared` ASYNCIFY build spike — **issue #88**, gated
   before M8. It slots in behind the SAME protocol later: the `capabilities` hook
   plus the reserved `SimControl` message shape make adding control ADDITIVE, not
   a rewrite (existing `run`/`cancel`/`preload` consumers do not change; M8 co-sim
   feature-detects on `capabilities.control`).
3. **Keep binding decision 2** (single-threaded, no SharedArrayBuffer) — preserves
   zero-backend / trivial static hosting and avoids the cross-origin-isolation
   conflict with BYOK direct-fetch (ADR 0008).

`packages/sim-wasm` implements items 1–2 of this decision. The original P0 finding,
its test evidence, and the deferred-work recommendation are retained below unchanged
— they are the justification for the split and the spec for #88.

## UPDATE (2026-07-24): a control-capable ngspice-WASM was built and verified — via a DIFFERENT mechanism

The "deferred, upstream-blocked" conclusion below is **superseded**. A control-capable
ngspice-WASM now builds and runs, and mid-transient host control is verified with
correct physics. Two findings changed the picture:

1. **ASYNCIFY halt/alter/resume is a genuine dead end for ngspice** (confirming the wall
   below, concretely): ASYNCIFY crashes with ngspice's `setjmp/longjmp` under legacy
   SjLj, and `wasm-opt --asyncify` aborts under `-fwasm-exceptions`, which `SUPPORT_LONGJMP=wasm`
   requires. ngspice cannot drop `setjmp/longjmp`, so ASYNCIFY cannot be the yield mechanism.

2. **Control does not need a yield mechanism at all.** ngspice's shared library exposes a
   **synchronous** external-source API — `ngSpice_Init_Sync` + a `GetVSRCData` callback:
   during ONE continuous transient, ngspice asks the host for each controlled source's
   value at every timepoint; paired with `SendData` (host reads node voltages back), this
   is full transient-preserving firmware⇄analog co-sim, entirely synchronously, with NO
   ASYNCIFY, threads, or SharedArrayBuffer.

**Build recipe:** `Dockerfile.ngshared` at the repo root — emsdk 3.1.60, **ngspice-46**
(the `github.com/ngspice` mirror is stale at v26; the tarball is fetched on the host and
`COPY`ed in because SF's mirror redirect is unreachable from inside the podman machine),
`--with-ngshared`, `SUPPORT_LONGJMP=wasm -fwasm-exceptions`, **no ASYNCIFY**, exporting
the sync C API + `addFunction`/`ALLOW_TABLE_GROWTH` (so JS can register the callbacks).
Runtime gotcha: provide a fake `/proc/meminfo` or ngspice's memory sizing blows up to a
1 GB alloc and aborts.

**Verified** (`packages/sim-wasm/src/node/ngshared.control.test.mjs`): a JS-driven source
(5 V→0 V at 2.5 ms) makes `V(out)` of an RC (τ=1 ms) charge to 4.589 V then discharge to
0.379 V in one continuous run — matching `5(1−e⁻²·⁵)` and `4.59·e⁻²·⁵` exactly. The
discharge-from-charged-state is impossible for quasi-static re-solve (cosim.ts), so this
is the real control capability.

**Still open (integration, not capability):** wire `ngshared` into the sim-wasm engine
protocol behind `capabilities.control`; rewrite `CoSimOrchestrator` to use
`GetVSRCData`+`SendData` driving the mpy-wasm firmware synchronously; the `/proc/meminfo`
shim in the loader; version alignment vs eecircuit-45.2; hermetic tests. M8 co-sim is
unblocked.

## Context

Epic #12 requires **real ngspice in the browser**, in a Web Worker, lazy-loaded,
**single-threaded** (binding decision 2: no SharedArrayBuffer, to keep static hosting
trivial). Binding decision 5 makes the control API load-bearing: the engine MUST
support **mid-transient halt / alter / resume** — pause a running transient, let
JavaScript change a source value *after observing the halted state*, then continue.
M8 firmware co-simulation (ADR 0010) is built entirely on this: the co-sim
orchestrator advances the analog engine to each firmware wake point, reads pin state,
and only then decides the next source value. A fire-and-forget engine is disqualified
regardless of other merits.

Two paths were to be evaluated (issue #13):
- **Path A:** adopt `eecircuit-engine` (npm) — ngspice compiled to WASM.
- **Path B:** build our own from ngspice source with Emscripten in shared-library mode
  (`--with-ngshared`, `ngSpice_Init` callbacks, `ngSpice_Command` control).

The control API was evaluated **first**, with **test evidence, not vendor claims**.

## Evaluation table

| Criterion | Path A — eecircuit-engine 1.7.0 | Path B — build `--with-ngshared` WASM |
|---|---|---|
| License | **MIT** ✅ (compatible) | ngspice: BSD/GPL mix; our build script MIT ✅ |
| ngspice version | **45.2+** (read from the built engine's own init banner, see Evidence #1) | selectable (we'd pin one) |
| Transient / DC / OP | ✅ (verified — divider tran runs, Evidence #2) | ✅ (same engine) |
| Output streaming | Partial — `out.raw` read once at end; a private `outputEvent` fires but the **public** API returns a single batched `Promise<ResultType>` | ✅ via `SendData`/`SendChar` callbacks (per-timepoint) |
| Worker compatibility | ✅ (`ENVIRONMENT="web,worker"`) | ✅ (buildable `web,worker`) |
| Single-threaded (no SAB) | ✅ (no pthreads) | ✅ **required**, but see control row |
| Bundle size | 19.48 MB `.mjs` with wasm inlined (needs external-wasm rebuild to lazy-chunk) | controllable |
| **halt / alter / resume (HARD REQ)** | ❌ **DISQUALIFIED** — batch `main()`, fixed stdin command list, atomic `runSim()`. Proven, Evidence #3–#4 | ❌ **NOT CURRENTLY ACHIEVABLE** — see below |

## The hard-requirement evidence (test evidence, not vendor claims)

### Evidence #1 — Path A is a **standalone `main()` build**, not shared-lib

The published typed API (`dist/main.d.ts`, verbatim) exposes only:
`start()`, `setNetList(input)`, `runSim(): Promise<ResultType>`, `getInfo()`,
`getInitInfo()`, `getError()`, `isInitialized()`. There is **no** `halt`, `stop`,
`pause`, `resume`, `alter`, `step`, or `bg_*` method.

Grepping the shipped bundle (`dist/eecircuit-engine.mjs`) for the shared-library
control symbols returns **zero** hits for every one of:
`ngSpice_Init`, `ngSpice_Command`, `ngGet_Vec_Info`, `bg_halt`, `bg_resume`,
`bg_run`, `SendChar`, `ControlledExit`, `sharedspice`.
It *does* contain `callMain` / `_main` / `cwrap` — i.e. this is ngspice's
**standalone executable** compiled to WASM and driven through **stdin**, confirmed
by the upstream build script (`--disable-debug`, no `--with-ngshared`;
`EXPORTED_RUNTIME_METHODS=["FS","Asyncify","callMain"]`).

### Evidence #2 — the engine runs a real transient correctly (baseline)

Running the corpus voltage divider (`analog_primitives`) through the engine in Node:
init banner `** ngspice-45.2+ : Circuit level simulation program`; final
**`v(mid) = 2.5`** V — matches the corpus report (`2.5V`) exactly. So the *simulation*
is real and correct; only the *control* is missing.

### Evidence #3 — the driver is a **fixed, atomic command list**

The `Simulation` class hardcodes the ngspice command sequence it feeds through stdin:

```
" ", "source test.cir", "destroy all", "run", "write out.raw"
```

`getInput()` merely replays this array. `runSim()` triggers the loop and returns **one**
Promise that resolves only after `write out.raw` — i.e. after the **entire** transient
has completed. JavaScript is given the whole program up front and receives one result at
the end. There is no re-entry point between `run` and result.

### Evidence #4 — ngspice pauses internally, but JS never regains control to alter

A netlist with an interactive `.control` block was fed to the engine:

```
.control
run
stop when time > 5ms
alter V1 = 5
resume
write out.raw
.endc
```

ngspice's own stderr proved it honored the breakpoint:
`1 : condition met: stop when time > 0.005` … `doAnalyses: pause requested` …
`run simulation interrupted`. **But** `runSim()` still resolved as a single atomic
Promise: the `stop`/`alter`/`resume` all executed inside one `callMain` invocation with
**no point at which JavaScript could observe the halted state and supply a value**. For
M8 co-simulation the altered value must be *computed by JS after seeing the halt* — that
round-trip is architecturally impossible here. Attempting to re-drive the underlying
emscripten module directly (`__getSpiceModuleForTests().callMain([])`) after `start()`
crashes with `main: Internal Error: jump to zero` — the batch main loop is single-shot
and already consumed. **Path A is disqualified.**

### Path B — why it is not currently achievable under our constraints

Path B's control model has two sub-paths, and **both are blocked**:

1. **`bg_run` + `bg_halt` + `bg_resume`** (the documented shared-lib control loop)
   explicitly runs the simulation in a **separate thread** (ngspice `shared.html`:
   "start the simulation in a separate thread … stop the simulator … alter … resume").
   Threads in WASM require **pthreads → SharedArrayBuffer → COOP+COEP**, which epic #12
   binding decision 2 forbids (it would break trivial static hosting, #29).

2. **Single-threaded foreground `stop`/`alter`/`resume` via `ngSpice_Command`** (the
   path that *would* fit our constraints, using ASYNCIFY to yield at the breakpoint) is
   blocked upstream: **a working `--with-ngshared` WASM build does not exist and is a
   known-open problem.** ngspice patch #99 (WASM) remains **unmerged**; the maintainer
   states "the shared library option doesn't seem to work well with Emscripten at the
   moment" and a 2025 attempt failed because the Emscripten toolchain drops the linker
   flags needed for WASM dynamic linking (`duplicate symbol: main`). No reproducible
   shared-lib WASM build is available to adopt, and producing one is an unsolved
   emscripten-dynamic-linking problem — not a task this issue can complete by "just
   building it."

   Additionally, this environment has **no Docker, no WSL, and no emsdk**, so even an
   experimental from-source build cannot be produced or CI-verified here; the issue's own
   deliverable ("commit the full reproducible Dockerfile … never a mystery .wasm blob")
   cannot be satisfied and validated in-session.

## Original P0 finding (pre-split; retained as the justification for #88)

At evaluation time the recommendation was **do not ship an engine**, because neither
path meets the hard requirement under the binding constraints, and shipping
eecircuit-engine while claiming the control API is met would be a hollow green check —
exactly what the issue and `AGENTS.md` prohibit. This was escalated as a **P0
architectural finding** on #13 rather than routed around.

The epic owner accepted the finding and **resolved it by the split at the top of this
ADR**: eecircuit-engine is adopted for fire-and-forget analog now (with
`capabilities.control = false`, honestly advertised), and the control-capable engine is
carved out to **issue #88**, gated before M8. The recommendation below is the spec for
that spike.

## Recommended next step — now scoped as issue #88 (gated before M8)

The single-threaded foreground `stop`/`alter`/`resume` model (Path B sub-path 2) is the
*correct* architecture and is compatible with binding decision 2 **in principle**. It is
blocked only by the missing `--with-ngshared` WASM build. Recommended resolution, in
priority order:

1. **Fund the `--with-ngshared` WASM build as its own spike** (Docker + emsdk, from
   ngspice source, single-threaded, ASYNCIFY, foreground `ngSpice_Command`
   stop/alter/resume). This is the on-strategy path; commit the Dockerfile per the issue.
   Prove halt/alter/resume with `ngSpice_Command("stop when time=T")` → observe →
   `ngSpice_Command("alter …")` → `ngSpice_Command("resume")`, asserting rtol 1e-3 vs a
   two-phase reference netlist.
2. **If (1) proves infeasible,** revisit binding decision 2: allow the threaded
   `bg_run`/`bg_halt`/`bg_resume` shared-lib build behind COOP+COEP for the co-sim route
   only, accepting the static-hosting cost — a decision only the epic owner can make.
3. Interim: analog-only, non-interactive simulation (single-shot transients, DC, OP) is
   fully deliverable on eecircuit-engine today and unblocks #14/#15 corpus parity. This
   should be its **own** issue and **must not** be labeled as satisfying the halt/alter/
   resume acceptance criterion.

## Alternatives considered

- **Hack interactivity into the batch engine** (feed commands one at a time to reclaim
  control between phases): rejected — the standalone main loop owns the stdin pump and is
  single-shot (Evidence #4); re-entry crashes.
- **wokwi/ngspice-wasm**: also a standalone (`--disable-debug`, no `--with-ngshared`)
  batch build with ASYNCIFY; same disqualification as Path A for control.
- **Ship analog-only now and call it done**: rejected — violates the prime directive and
  the issue guardrail; a hollow green check on a load-bearing criterion.
