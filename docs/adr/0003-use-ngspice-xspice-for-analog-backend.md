# ADR 0003: Use ngspice/XSPICE For Analog Backend

## Status

Accepted

## Context

The MVP needs analog simulation for battery dividers, rails, passives, and later
mixed-signal bridges.

## Decision

Emit ngspice-compatible netlists first and leave room for XSPICE code models.

## Consequences

The CLI can produce standard analog artifacts while the IR stays backend-neutral.

## Alternatives Considered

Custom analog solver only, commercial simulators, or skipping simulation.

