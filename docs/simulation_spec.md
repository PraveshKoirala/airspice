# Simulation Spec v0.1

`air simulate` validates the XML, compiles the selected profile, runs ngspice
when available, and writes structured reports to `generated/reports`.

When ngspice is unavailable, the MVP uses a deterministic DC fallback for
supported passive divider assertions.

Supported assertions:

- `assert_voltage net="..." min="..." max="..."`
- `assert_current component="..." min="..." max="..."`

Reports are structured JSON and suitable for `air repair-context`.

Each report includes:

- `measurements`: final value per signal.
- `measurement_stats`: final/min/max/time-of-min/time-of-max per signal.
- `diagnostics`: assertion failures and compiler diagnostics.

ngspice CSV output is parsed when available. If ngspice is not installed, the
deterministic fallback supports voltage sources, resistor dividers, ideal LDO
outputs, generic load currents, and current/load-step setup values.
