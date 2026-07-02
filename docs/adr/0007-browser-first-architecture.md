# ADR 0007: Browser-first architecture

## Status
Accepted (2026-07-02)

## Context
The v0.2.x system runs all computation in a local Python backend (FastAPI + native ngspice + Renode + PlatformIO). The product vision requires zero-install usage, near-zero hosting cost, and latency independent of user count. A server-full architecture cannot deliver any of the three: every user's simulation would consume operator compute, and local installation gates adoption.

## Decision
The deployed product is a static webapp. All deterministic computation — parsing, validation, compilation, analog simulation, firmware execution, agent tool execution — runs client-side (TypeScript + WebAssembly in Web Workers). The Python core is demoted to a reference oracle (ADR 0009). No feature may require a server; optional server-backed features (house agent proxy) must be flagged and degrade gracefully to the client-only path.

## Consequences
- Porting cost: the Python engine's behavior must be reproduced in TypeScript with golden-fixture parity gates (roadmap M1).
- Simulation runs 2–4x slower than native ngspice; accepted — interactivity and zero install outweigh raw speed for the target audiences.
- ISA-level firmware co-simulation (Renode) does not port; the browser gets behavioral co-simulation instead (ADR 0010). The desktop track (AINativeSpice repository) retains the native path.
- Operator cost becomes ~fixed at ~$0 regardless of user count, which is the strategic survival property of the project.
