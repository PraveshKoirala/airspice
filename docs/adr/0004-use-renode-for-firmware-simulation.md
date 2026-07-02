# ADR 0004: Use Renode For Firmware Simulation

## Status

Proposed

## Context

Firmware and MCU behavior should eventually be simulated separately from analog
SPICE.

## Decision

Use Renode for firmware simulation once the firmware skeleton is stable.

## Consequences

The XML IR already models firmware bindings and bridges, but Renode generation is
not implemented in this CLI slice.

## Alternatives Considered

QEMU-only firmware simulation, hardware-in-loop, or no MCU simulation.

