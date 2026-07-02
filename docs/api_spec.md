# API Spec v0.1

Run locally:

```powershell
python -m air.cli serve --host 127.0.0.1 --port 8000
```

Implemented FastAPI routes:

- `POST /validate`
- `POST /compile`
- `POST /simulate`
- `POST /check`
- `POST /repair-context`
- `POST /patch-preview`
- `POST /patch`
- `POST /repair`
- `POST /ai-repair`
- `POST /build-firmware`
- `POST /run-renode`
- `POST /repair-session/start`
- `POST /repair-session/apply`

Example:

```json
{
  "design": "examples/esp32_battery_sensor/design.air.xml"
}
```

Compile request:

```json
{
  "design": "examples/esp32_battery_sensor/design.air.xml",
  "target": "spice",
  "out_dir": "generated/api"
}
```

The API uses the same Python service layer as the CLI, so command-line and HTTP
behavior should stay aligned.

Repair session start request:

```json
{
  "design": "examples/failing/bad_adc_divider.air.xml",
  "provider": "mock",
  "out_dir": "generated/repair_session"
}
```

Firmware runner request:

```json
{
  "design": "examples/esp32_battery_sensor/design.air.xml",
  "out_dir": "generated/firmware_build"
}
```
