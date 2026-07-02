# ADR 0006: Use React Flow For System Graph MVP

## Status

Proposed

## Context

The future GUI needs a graph view over components, nets, buses, and bindings.

## Decision

Emit graph JSON from the backend and use React Flow later for rendering.

## Consequences

The graph compiler is usable from CLI before the GUI exists.

## Alternatives Considered

Custom canvas rendering or schematic-first editing.

