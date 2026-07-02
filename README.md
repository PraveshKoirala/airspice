# AirSpice

**AI-native circuit design, simulation, and firmware co-simulation — entirely in your browser.**

Describe a device. An agent designs the circuit, writes the firmware, simulates both together against a real SPICE engine, and fixes its own mistakes — with nothing to install, no account, and no server doing the work. Bring your own LLM API key (it never leaves your browser) or use the optional house agent.

## Status: pre-alpha, roadmap-driven

This repository is being built by a swarm of implementing agents driven by GitHub issues. The full strategy lives in [docs/NORTH_STAR.md](docs/NORTH_STAR.md) and the pinned roadmap issue. **If you are an implementing agent: read [AGENTS.md](AGENTS.md) before touching anything.**

What works today: the **Python reference engine** (`packages/core`) — parser, validator, SPICE/graph/firmware compilers, ngspice simulation, AI repair loop, CLI and FastAPI server — plus a server-coupled React UI (`packages/ui`). This is the *oracle*, not the product. The product — a fully client-side webapp — is what the roadmap builds, with every port verified against the oracle's frozen golden fixtures.

## Architecture (target)

```
Browser (static files from a CDN — no required backend)
├── packages/air-ts     TypeScript AIR engine: parse → validate → emit
│                       (SPICE netlist, schematic graph, XML patches)
├── packages/sim-wasm   ngspice compiled to WebAssembly, in a Web Worker
├── packages/mpy-wasm   MicroPython (WASM) executing real firmware code
│                       against virtual MCU peripherals, lockstepped with
│                       the analog solver on a shared virtual clock
├── packages/agent      BYOK agent layer: Anthropic / OpenAI / Gemini
│                       direct from the browser; every write gated by
│                       deterministic validation
└── packages/ui         React IDE: editable schematic, Monaco, canvas
                        waveforms, agent chat, local-first storage

packages/core (Python)  Reference oracle: source of golden fixtures,
                        CI parity gate for every port. Never deployed.
```

## Running the reference engine (development)

```powershell
# Backend API
$env:PYTHONPATH = "packages/core/src"
python -m air.cli serve --host 127.0.0.1 --port 8000

# Frontend
cd packages/ui
npm install
npm run dev

# Tests
python -m pytest tests/
```

External tool overrides (ngspice, Renode, PlatformIO) are read from `.env` — see `air/tools.py`.

## Roadmap

Milestones M0–M8, tracked as GitHub issues:

- **M0 Foundation & Guardrails** — CI, golden fixture corpus, dead-code purge
- **M1 Browser Core Engine** — `air-ts` with byte-parity against the oracle
- **M2 In-Browser Simulation** — ngspice WASM worker, waveforms, assertions
- **M3 Agent Layer** — BYOK providers, gated tool runtime, autonomous repair
- **M4 Design Surface UX** — direct-manipulation schematic editing, undo/redo
- **M5 Local-First & Sharing** — IndexedDB projects, file I/O, circuit-in-a-URL
- **M6 Ship** — static CDN deploy, enforced performance budgets, PWA
- **M7 Ecosystem & Interop** — registry growth, SPICE import, KiCad export, MCP
- **M8 Real Firmware in the Browser** — MicroPython co-simulation with the analog solver; agents repair code and circuit together

What this platform deliberately does **not** do (PCB layout, cycle-accurate MCU emulation, WiFi/BLE stacks, compiled C++ in the browser) is documented with reasons in [docs/NORTH_STAR.md](docs/NORTH_STAR.md#what-we-refuse-to-build).

## Origin

Forked from the [AINativeSpice](https://github.com/PraveshKoirala/AINativeSpice) research line, which continues as the local/desktop track (native ngspice, Renode ISA-level co-simulation, PlatformIO builds). This repository is the everything-in-the-browser track.
