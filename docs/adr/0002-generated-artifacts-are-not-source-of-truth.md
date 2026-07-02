# ADR 0002: Generated Artifacts Are Not Source Of Truth

## Status

Accepted

## Context

The AI repair loop needs one controlled mutation surface.

## Decision

Generated artifacts live under `generated/` and are recreated from the XML IR.

## Consequences

AI patches target XML, not backend-specific outputs.

## Alternatives Considered

Allowing direct edits to SPICE, firmware, Renode scripts, or future KiCad files.

