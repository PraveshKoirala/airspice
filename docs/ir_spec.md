# AIR: AI-Native Intermediate Representation (v0.1)

AIR is an electronics design description format specifically optimized for agentic reasoning and automated synthesis.

The schema in `schemas/air.xsd` is intentionally permissive while semantic
validation lives in Python rules.

Registries live under `registry/`. MCU pin/peripheral data is loaded from JSON
with built-in fallback definitions for ESP32-C3 and ESP32-WROOM-32.

Component type validation is registry-driven via `registry/components/*.json`.
The current registry covers resistor, capacitor, voltage source, current source,
generic load, LDO, and MCU component requirements.
