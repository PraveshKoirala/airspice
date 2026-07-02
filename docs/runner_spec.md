# Runner Spec v0.1

Implemented runners:

- `build-firmware`: generates PlatformIO firmware and invokes `platformio run`
  when PlatformIO is installed.
- `run-renode`: generates Renode placeholder artifacts and invokes `renode` when
  Renode is installed.

If a tool is unavailable, the runner returns a structured warning diagnostic and
keeps generated artifacts in place.

```powershell
python -m air.cli build-firmware examples/esp32_battery_sensor/design.air.xml --out-dir generated/firmware_build --json
python -m air.cli run-renode examples/esp32_battery_sensor/design.air.xml --out-dir generated/renode_run --json
```

Current expected local behavior on machines without these tools:

- `PLATFORMIO_NOT_INSTALLED`
- `RENODE_NOT_INSTALLED`
