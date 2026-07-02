# ADR 0010: Firmware in the browser is real MicroPython on behavioral peripherals

## Status
Accepted (2026-07-02)

## Context
Browser firmware simulation has three hard problems: cross-compiling C/C++ (toolchains don't fit in a tab; Wokwi compiles server-side), emulating the MCU (Renode is a heavyweight .NET runtime; per-ISA emulators are large per-family investments), and synchronizing digital with analog time (tractable — the existing Python runners already time-slice).

Interpreted firmware dissolves the first two: user code is text, and the "MCU" becomes a behavioral model of its peripherals rather than its instruction set. MicroPython has an official WebAssembly port and is a mainstream real embedded language (ESP32, RP2040).

## Decision
- Firmware in the browser is MicroPython source, embedded in the AIR document (`<firmware language="micropython">`), executed by the MicroPython WASM runtime in a Web Worker.
- MCU peripherals (GPIO, ADC, PWM, timers, console) are behavioral models driven by the registry's MCU definitions; `machine`/`time` shims bridge them to the co-simulation bus.
- Time is virtual: `sleep_ms`/`ticks_ms` advance the shared simulation clock. The orchestrator advances the analog engine (via sim-wasm's halt/alter/resume control API) to each firmware wake point and exchanges pin state.
- Fidelity contract: event-level behavioral accuracy (control loops, sensor logic, PWM duty effects). Explicitly NOT cycle-accurate — no ISR latency, no bit-banged µs protocols, no DMA/RTOS. The UI states this boundary.
- Compiled C/C++ stays on the desktop track; Arduino sketches may be agent-translated to MicroPython as an import affordance.

## Consequences
- The sim-wasm engine MUST expose mid-transient halt/alter/resume; engine candidates that cannot are disqualified (encoded in the M2 issues).
- PWM bridges as parameterized PULSE sources updated on duty/frequency change, not per-edge lockstep — captures filtered/averaged behavior at tractable cost.
- Determinism: virtual clock + defined event ordering make co-simulation reproducible in CI, which real hardware cannot offer.
- A second WASM runtime ships (lazy-loaded, ~brief MB): acceptable against the capability unlocked.
