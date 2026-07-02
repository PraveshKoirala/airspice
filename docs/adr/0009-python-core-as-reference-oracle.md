# ADR 0009: The Python core is a vendored reference oracle

## Status
Accepted (2026-07-02)

## Context
The Python engine (`packages/core`) is the only complete, tested implementation of AIR semantics: parsing leniencies, validation rules, netlist emission, report schemas. Porting to TypeScript without a continuously verified ground truth would accumulate silent divergence — the classic failure mode of rewrites, amplified when implementing agents are optimizing for green checkmarks.

## Decision
The Python core stays in this repository permanently as the reference oracle:
- `scripts/export_golden.py` freezes its outputs into `tests/golden_corpus/` (inputs, canonical XML, model dumps, diagnostics, netlists, graphs, simulation reports).
- CI verifies (a) the oracle still reproduces the corpus byte-for-byte, and (b) every TS/WASM port matches the corpus per its issue's parity contract.
- Schema/IR evolution is oracle-first: changes land in the Python engine and regenerated fixtures before any TypeScript implementation.
- The oracle is never deployed, never called by the product at runtime, and its server/CLI remain available for local power use.

## Consequences
- Two implementations to maintain; accepted as the price of a rewrite that stays honest. The oracle freezes once parity is complete except for oracle-first schema changes.
- Fixtures are data, hand-editing them is prohibited (see AGENTS.md), and fixture regeneration appears in diffs where reviewers can see exactly what behavior changed.
