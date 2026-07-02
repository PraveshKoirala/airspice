# North Star: AirSpice

This document is the binding strategy for the repository. Issues implement it; ADRs record its decisions; [AGENTS.md](../AGENTS.md) enforces its discipline. If an issue and this document conflict, stop and raise it — do not pick one silently.

## Vision

A browser-first, AI-native electronics workbench. Parsing, validation, schematic editing, real SPICE simulation, real firmware execution, and the AI agent loop all run **client-side** from statically hosted files. Server costs ~zero; latency is independent of user count; users bring their own LLM key or use an optional metered house agent.

**The wedge:** real SPICE + real firmware code + an agent that verifies and repairs both — in one browser tab.

- Wokwi executes real firmware, but has no real analog solver.
- Falstad/CircuitJS is instant in-browser analog, but idealized toy models and no code.
- LTspice is real SPICE, desktop-bound, no code, no AI.
- Tinkercad has code + circuits, both toy-grade, no agent.
- Flux is server-heavy, PCB-focused, shallow AI.

Nobody occupies the quadrant this repo builds. Cost is not the pitch — it is the survival property that lets an indie project play an infinite game while every server-bound competitor pays per user.

## Target architecture

```
Browser (static hosting; no required backend)
├── air-ts      TypeScript AIR engine (parse, validate/ERC, canonicalize,
│               emit SPICE netlist / schematic graph, patches, normalizer)
├── sim-wasm    ngspice as WebAssembly in a Web Worker; halt/alter/resume
│               control API (load-bearing for co-simulation)
├── mpy-wasm    MicroPython (WASM) executing user firmware against virtual
│               MCU peripherals (GPIO/ADC/PWM/timers) on a VIRTUAL clock
├── cosim       Lockstep orchestrator: event-driven time slicing between
│               firmware and analog; pin/net bridges
├── agent       Provider abstraction (Anthropic/OpenAI/Gemini/mock), BYOK
│               key vault, tool runtime, autonomous repair loop
└── ui          React IDE: editable SVG schematic, Monaco, canvas waveform
                viewer, chat, IndexedDB projects, share links, PWA

packages/core (Python): REFERENCE ORACLE. Produces the golden fixture
corpus; CI verifies every TS/WASM port against it. CLI for power users.
Never deployed as a service. (ADR 0009)
```

## Non-negotiable principles

1. **Parity or it didn't happen.** Every ported behavior is gated by golden-fixture parity in CI. The oracle is authoritative until a behavior is formally deprecated there first (oracle-first evolution: schema changes land in Python + fixtures before TypeScript).
2. **The XML IR is the only source of truth.** Designs, firmware source, layout hints, simulation profiles — one artifact, round-tripped everywhere (editor, agent, share links, exports).
3. **Agents propose, validators dispose.** No LLM output touches a design except through normalize → validate → user-visible diff. Humans use the same single write path.
4. **Zero-backend default.** The deployed product is static files. Any server-dependent feature is optional, flagged, and degrades gracefully.
5. **The main thread is sacred.** Heavy work happens in workers; jank is a bug with a budget attached.
6. **Virtual time only.** Firmware and analog share one simulated clock. Determinism is a feature: same inputs → identical results, in CI, forever.

## Capability contract

### What the platform does (end state)

| Domain | Capability |
|---|---|
| Analog | Real ngspice: DC op, sweeps, transients; R/C/L, diodes, BJTs, MOSFETs, op-amps, regulators with provenance-tracked models |
| Verification | Declarative assertions, measurement stats, structured pass/fail reports |
| Firmware | Real MicroPython source executing against virtual GPIO/ADC/PWM/timers, lockstepped with the analog solver |
| AI | NL → circuit; iterative editing; autonomous simulate-diagnose-repair across circuit AND code; BYOK or house agent |
| Platform | Zero-install, offline PWA, local-first projects, circuit-in-a-URL sharing, KiCad schematic export, SPICE import, MCP/headless access |

### What we refuse to build (and why)

- **Cycle-accurate MCU emulation** — interrupt latency, bit-banged µs protocols, DMA, RTOS scheduling. Event-level behavioral fidelity covers the target users; ISA emulation costs 100x for the last 5%. The desktop track (AINativeSpice + Renode) serves that need.
- **WiFi/BLE stacks** — we simulate the sensing/driving half of connected devices, not the network half. Say it in the UI.
- **Compiled C/C++ firmware in the browser** — no cross-toolchain will be shipped to a browser tab. Arduino sketches get agent-assisted translation to MicroPython; real C++ builds stay on the desktop track.
- **PCB layout/routing/DRC** — we are the front half of the flow; KiCad export is the bridge. No footprints, no 3D viewers.
- **IC-scale/professional sim** — no PDKs, encrypted vendor models, EM/RF, IBIS, thermal. Practical interactive ceiling: low hundreds of components.
- **Real-time multiplayer** — local-first + share links. Collaboration servers reintroduce the cost curve this architecture exists to avoid.

## Performance budgets (initial; CI-enforced by the roadmap)

| Operation | Budget |
|---|---|
| Repeat/offline app load | < 1 s |
| First-run WASM fetch (lazy, once) | 2–5 s with visible progress |
| Keystroke → schematic + ERC refresh | < 200 ms |
| Small sim (op / short transient) | < 500 ms |
| Dense transient (10⁵–10⁶ points) | seconds, streaming waveforms while running |
| 10 s firmware+analog co-sim (maker-typical) | ≤ 60 s wall |
| Initial JS payload (gzipped, pre-lazy-chunks) | ≤ 250 KB |

Positioning note: idealized simulators will always *feel* faster. The counter is instant-where-it-matters plus honesty: when AirSpice takes 20 seconds, it is computing the truth, not an approximation.

## Cost model

- Static hosting (Cloudflare Pages class): ~$0. CI on public repo: $0. Domain: ~$15/yr.
- Fixed cost is independent of user count — every user brings their own compute and (BYOK) their own inference.
- The only variable cost is the optional house agent: ~$0.01–0.02 per chat turn, ~$0.10 per autonomous repair on an economy-tier model; hard monthly cap, fails closed to BYOK.

## Audiences, in order

1. **Education** (embedded/EE courses): zero-install, assignments shared as URLs, deterministic grading via headless mode.
2. **Makers and AI tinkerers**: they already hold API keys; the cross-domain repair demo is built for them.
3. **Agent builders** (MCP): AirSpice as the tool *other* agents use to do electronics. Small today, compounding.
4. Professional EEs: welcome as a scratchpad; never over-promised to.

## Milestone map

M0 Foundation & Guardrails → M1 Browser Core Engine (air-ts) → M2 In-Browser Simulation (sim-wasm) → M3 Agent Layer (BYOK) → M4 Design Surface UX → M5 Local-First & Sharing → M6 Ship (deploy + budgets + PWA) → M7 Ecosystem & Interop (registry, import/export, MCP) → M8 Real Firmware in the Browser (MicroPython lockstep co-sim).

Dependency spine: M0's golden corpus gates M1; M1's netlist parity gates M2; M2's engine control API (halt/alter/resume) gates M8; M3 consumes M1+M2 through one engine facade. M4–M7 parallelize once M1 lands.
