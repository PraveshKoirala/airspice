# Compiler Spec v0.1

Compilers receive typed `SystemIR` and write generated artifacts.

Implemented targets:

- `spice`: emits `generated/spice/main.cir` and probe metadata.
- `firmware`: emits a PlatformIO/Arduino scaffold.
- `graph`: emits graph JSON for a future UI.
- `renode`: emits placeholder Renode platform/script/test artifacts.

Generated artifacts are disposable and should not be edited as source.

CLI product helpers now include `generate-template`, `explain`,
`patch-preview`, `repair-context`, and deterministic `repair`.

Firmware generation now maps declared firmware tasks into Arduino-style code for:

- `read_adc`
- `convert` with `battery_raw_to_mv(...)`
- `log`

The pinmap includes both ADC channel and GPIO pin macros when the binding can be
resolved from the MCU pin assignment.
