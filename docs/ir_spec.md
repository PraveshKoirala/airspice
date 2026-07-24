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

## Inline firmware source on `<firmware>` (issue #36)

The existing `<firmware>` section holds the DECLARATIVE firmware description
(`<project>`, `<binding>`, `<task>` children). Issue #36 adds a second, coexisting
representation: REAL inline firmware **source code** carried in a `<source>` CDATA
child, with the MCU/language/entry/declared-pins metadata on the `<firmware>`
element itself. This source is what the mpy-wasm runtime (issue #37) executes.

```
<firmware mcu="U_MCU" language="micropython" entry="main" pins="GPIO4,GPIO5">
  <source><![CDATA[
from machine import ADC, Pin
adc = ADC(Pin(4))
pump = Pin(5, Pin.OUT)
while True:
    mv = adc.read_u16() * 3300 // 65535
    pump.value(1 if mv < 1200 else 0)
  ]]></source>
</firmware>
```

Attributes on `<firmware>` (all optional; present only when a `<source>` child is):

| attribute  | meaning                                                                 |
|------------|-------------------------------------------------------------------------|
| `mcu`      | id of a component whose registry type is an MCU (the firmware's target) |
| `language` | runtime language tag (`micropython` today)                              |
| `entry`    | entry-point symbol the runtime invokes                                  |
| `pins`     | DECLARED-PINS manifest: comma-separated MCU pin ids the firmware uses    |

Typed model: `SystemIR.firmware_source` is a `FirmwareSource(mcu, language, entry,
pins, source)` when a `<source>` child is present, else `None`. `pins` parses the
comma-separated `pins` attribute into an ordered tuple (each token trimmed, empty
tokens dropped). `source` holds the raw program text.

### Validation (declared-only; the source is never analyzed)

| code                     | when                                                          |
|--------------------------|--------------------------------------------------------------|
| `FIRMWARE_MCU_UNDEFINED` | `mcu` names no component                                     |
| `FIRMWARE_MCU_NOT_MCU`   | `mcu` names a component that is not MCU-typed                 |
| `FIRMWARE_PIN_NOT_ON_MCU`| a DECLARED `pins` id is not on that MCU's registry pin set    |

The pin check compares each declared pin against the union of the MCU registry's
`pins` and `power_pins` keys. It runs only when `mcu` resolves to an MCU-typed
component whose `part` is in the registry (an unknown part is already reported as
`UNKNOWN_MCU_PART` by the component pass). Crucially, the source text is NEVER
statically parsed to discover pins — the `pins` manifest is the sole input to this
check. This is the sanctioned simpler design per the issue.

### Fidelity boundary (byte-exact source)

The `source` text is preserved BYTE-EXACT end to end. The canonicalizer does NOT
reindent, trim, reflow, or otherwise normalize it beyond the XML parser's standard
line-ending rule (`\r\n` / `\r` → `\n`, applied by expat / fast-xml-parser to all
character data). On emit it is wrapped in a single CDATA section; any literal
`]]>` inside the program is split-escaped as `]]]]><![CDATA[>` so the two CDATA
runs re-merge to the original bytes on the next parse. Tabs, trailing spaces,
blank lines, and unicode all round-trip through parse → canonicalize → parse
unchanged. A canonicalizer that "cleaned up" the code would corrupt the user's
program, so this is a hard contract, verified byte-for-byte against the Python
oracle by the air-ts port and the golden corpus (`firmware_battery_monitor`
embeds a literal `]]>` to lock the split-escaping into the frozen fixtures).

Backward compatibility: a `<firmware>` without these attributes and without a
`<source>` child parses and validates exactly as before. `model.json` omits the
`firmware_source` key entirely when it is `None`, so no pre-#36 corpus fixture is
regenerated.
