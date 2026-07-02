# Project Spec v0.1

Projects are described by `air.project.json`.

Example:

```json
{
  "name": "sensor_node",
  "design": "design.air.xml",
  "generated_dir": "generated",
  "default_profile": "analog_only",
  "registry_paths": ["registry"],
  "enabled_backends": ["ngspice", "firmware", "renode"]
}
```

Create a project:

```powershell
python -m air.cli init sensor_node --template esp32-battery-sensor
python -m air.cli project-info --project sensor_node --json
```

