# ADR 0001: Use XML As Canonical IR

## Status

Accepted

## Context

The platform needs a stable representation that both deterministic tools and AI
agents can inspect and patch.

## Decision

Use `design.air.xml` as the canonical source of truth.

## Consequences

Generated SPICE, firmware, reports, and future KiCad files are reproducible and
disposable.

## Alternatives Considered

Direct schematic files, direct SPICE, and generated firmware as source of truth.

