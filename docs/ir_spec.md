# AIR: AI-Native Intermediate Representation (v0.1)

AIR is an electronics design description format specifically optimized for agentic reasoning and automated synthesis.

The schema in `schemas/air.xsd` is intentionally permissive while semantic
validation lives in Python rules.

Registries live under `registry/`. MCU pin/peripheral data is loaded from JSON
with built-in fallback definitions for ESP32-C3 and ESP32-WROOM-32.

Component type validation is registry-driven via `registry/components/*.json`.
The current registry covers resistor, capacitor, voltage source, current source,
generic load, LDO, and MCU component requirements.

## Analysis type on `<test>` (issue #62)

By default a `<test>` compiles to an ngspice `.tran` transient over the duration
given by its `<run duration="..."/>` child. A test can OPT-IN to a small-signal
AC sweep instead by adding an `<analysis>` child:

```
<test id="lpf_fc">
  <analysis type="ac" sweep="dec" points="40" start="10Hz" end="1MegHz"/>
  <assert_gain_db_at_freq net="vout" freq="994.72Hz" min_db="-3.15" max_db="-2.87"/>
</test>
```

Attributes (all optional, defaults shown):

| attribute | default    | meaning                                             |
|-----------|------------|-----------------------------------------------------|
| `type`    | `ac`       | analysis kind; today only `ac` is honoured          |
| `sweep`   | `dec`      | sweep spacing: `dec` / `oct` / `lin` (ngspice §15.3.1) |
| `points`  | `20`       | points per decade/octave (or total, for `lin`)      |
| `start`   | `10Hz`     | start frequency (parsed by `air.units.parse_quantity`) |
| `end`     | `1MegHz`   | end frequency                                       |

When `type == "ac"`:

* every `<component type="voltage_source">` is emitted with `AC {ac_magnitude}`
  in addition to its DC bias. Sources whose `<property name="ac_magnitude"
  value="..."/>` is absent default to `AC 0`, i.e. they act as pure biases and
  contribute nothing to the frequency response;
* the netlist ends with `.ac {sweep} {points} {start_hz} {end_hz}` instead of
  `.tran`, verbatim from the ngspice-46 manual §15.3.1;
* every probed net is written to a per-probe CSV via
  `wrdata ../waveforms/<test>_<net>.csv vdb(<net>) vp(<net>)` (magnitude in dB
  and phase in radians per frequency point, ngspice-46 manual §15.6);
* the simulator parses the CSV, converts phase to degrees, and populates a
  `frequency_response` section on the report (list of `{freq_hz, mag_db,
  phase_deg}` per net) alongside the existing measurements;
* the new assertion type `<assert_gain_db_at_freq net="..." freq="..."
  min_db="..." max_db="..."/>` picks the closest-in-log-frequency sample point
  and checks its magnitude in dB against the window.

Backward compatibility: a `<test>` WITHOUT an `<analysis>` child compiles to
exactly the pre-#62 netlist bytes; no golden-corpus design changes.
The IR round-trip (`model.json`) omits the `analysis` field entirely on a test
whose `analysis` is null, so pre-#62 corpus fixtures need no regeneration.
