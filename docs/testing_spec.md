# Testing Spec v0.1

The test suite uses Python `unittest` and is intentionally dependency-light.

```powershell
python -m unittest discover -s tests
```

Coverage includes:

- XML validation success/failure examples.
- Simulation pass/fail behavior.
- XML patch and deterministic repair flows.
- Template/init/explain/patch-preview/check CLI commands.
- Analog primitive simulation with current assertions.
- Golden compiler outputs for SPICE, firmware, and graph JSON.
- Project metadata, JSON CLI outputs, mock AI repair, and FastAPI validation.
- Repair sessions, PlatformIO/Renode runner diagnostics, and OpenAI provider
  missing-key behavior.

Golden fixtures live under `tests/golden/` and protect byte-stable compiler
output for representative generated artifacts.
