# CLI Spec v0.1

Core commands:

- `air init PROJECT --template TEMPLATE`
- `air project-info --project PROJECT [--json]`
- `air generate-template TEMPLATE --out design.air.xml`
- `air validate design.air.xml [--json]`
- `air canonicalize design.air.xml --out design.canonical.air.xml`
- `air explain design.air.xml [--json]`
- `air compile design.air.xml --target spice|firmware|renode [--json]`
- `air simulate design.air.xml --profile analog_only [--json]`
- `air graph design.air.xml --out graph.json`
- `air repair-context design.air.xml [--report report.json] --out context.json`
- `air patch-preview design.air.xml patch.xml [--json]`
- `air patch design.air.xml patch.xml --out design.fixed.air.xml [--json]`
- `air repair design.air.xml [--report report.json] --out repair.patch.xml [--apply-out fixed.air.xml] [--json]`
- `air ai-repair design.air.xml --provider mock --out repair.patch.xml [--apply-out fixed.air.xml] [--json]`
- `air check design.air.xml --profile analog_only --out-dir generated/check [--json]`
- `air build-firmware design.air.xml --out-dir generated [--json]`
- `air run-renode design.air.xml --out-dir generated [--json]`
- `air repair-session-start design.air.xml --provider mock|openai --out-dir generated/repair_session [--json]`
- `air repair-session-apply design.air.xml patch.xml --out fixed.air.xml [--json]`
- `air serve --host 127.0.0.1 --port 8000`

Templates:

- `esp32-battery-sensor`
- `esp32-i2c-sensor`
- `voltage-divider`
- `overloaded-rail`

Deterministic repair is intentionally narrow. It currently handles known ADC
divider failures and overloaded-regulator diagnostics.

`air check` is the one-command local confidence pass. It validates, compiles the
SPICE target, simulates the selected profile, and writes `repair_context.json`
when the design fails.

`air init` writes `air.project.json` with the design path, generated directory,
default profile, registry paths, and enabled backends.

`build-firmware` and `run-renode` return structured diagnostics when PlatformIO
or Renode are unavailable, while still generating their target artifacts.
