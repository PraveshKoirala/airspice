# Build-benchmark sensor/peripheral abstraction convention

Status: normative for the generative build benchmark (epic #104). Child B (#106,
the spec corpus) references this document; child C (#107, the scorer) reads the
`faithful` / `abstracted` tag defined here.

## Why this exists

The build benchmark asks an agent to build real MCU circuits from natural-language
specs, scored by **validate + simulate**. The registry cannot faithfully model
every sensor and peripheral in the world — the parts ceiling is real and finite
(see #104's honest caveats). Rather than pretend, we make the gap **explicit and
machine-checkable**: every circuit a spec asks for is tagged either `faithful`
(built from a real modelled part) or `abstracted` (built from a documented
electrical stand-in). The tag is the honesty mechanism. A scorer, a reviewer, or
a results table can then say exactly which circuits tested real device physics and
which tested the agent's wiring/topology reasoning against a stand-in.

This document defines (1) the three stand-in primitives, (2) how to pick one, and
(3) the tagging rule.

## The three stand-in primitives

A non-modelled sensor or peripheral is represented in a build spec by one of three
primitives already supported by the SPICE emitter (`air/spice.py`) and validation
(`air/validation.py`). No new component type is introduced — these are the
existing `voltage_source`, `resistor`, and `generic_load` primitives used with a
documented convention.

### 1. Fixed-output sensor -> `voltage_source`

Use when the sensor presents a **voltage** to the MCU that, for the scenario under
test, is a fixed value (an analog sensor whose output you assert at one operating
point; a reference; a pre-conditioned signal).

- Component: `type="voltage_source"`, `<value>` = the sensor's output voltage.
- Emits: `V_<id> p n DC <value>` — a stiff DC source.
- Sim assertion: the MCU ADC pin (or downstream node) sits at that voltage.
- Example: "a 0-3.3 V analog sensor reading 1.65 V" -> a 1.65 V source into the
  ADC net.

### 2. Variable-resistance sensor -> `resistor` divider

Use when the sensor **is** a resistance that varies with the measured quantity
(thermistor, photoresistor, potentiometer, flex/force sensor). The sensor is a
`resistor` whose `<value>` is its resistance at the condition under test, wired as
one leg of a divider so the MCU reads a voltage.

- Component: `type="resistor"`, `<value>` = R at the tested condition. May carry a
  `part="..."` attribute naming a registry entry (e.g. `NTC_10K_3977`,
  `LDR_GL5528`) for traceability; `part` on a resistor is informational and does
  not change emission or validation.
- Emits: `R_<id> a b <value>` — a plain resistor. The divider partner is another
  `resistor`; the tap is the MCU ADC net.
- Sim assertion: the divider tap voltage at the tested condition (hand-derived,
  per #32/#41 ground-truth discipline).
- Provenance: the resistance-vs-quantity law and datasheet nominal live in the
  registry entry (see `registry/imported/ntc_10k_3977.json`,
  `registry/imported/ldr_gl5528.json`). The core sensor models added by #105
  (thermistor NTC, photoresistor LDR) are **behavioral parameterized resistors**,
  not datasheet-exact thermal/optical SPICE models — the temperature/illuminance
  is chosen by the spec author as the resistor `<value>` at that condition. This
  is documented per part in the registry `provenance_note` and in each ground-truth
  circuit's `derivation.md`.

### 3. Current-sink peripheral -> `generic_load`

Use when the part's **electrical** effect on the circuit is that it draws current
from a rail (a digital sensor / IC / module whose data path is out of analog
scope, an LED module, a fan, a buzzer). The part is a `generic_load` with a
`current` (or `value`) property equal to its supply draw.

- Component: `type="generic_load"`, `current` property (or `<value>`) = supply
  draw. May carry `part="I2C_SENSOR_STUB"` (or similar) for traceability.
- Emits: `I_<id> p n DC <current>` — a DC current sink.
- Sim assertion: rail load budget (does the source/regulator survive the draw),
  and — for I2C — the idle bus sits at the rail through the pull-ups.
- I2C peripherals additionally use the `<interface type="i2c">` pattern: two
  `<pullup>` resistors to the sensor rail plus the `generic_load` supply draw.
  See `registry/imported/i2c_sensor_stub.json` and the `i2c_sensor_stub`
  ground-truth circuit. This models the electrical envelope ONLY — supply current
  and open-drain pull-up topology. The sensor's data value is **out of analog
  scope**; executable firmware that reads a register is M8, not this epic.

## Choosing a primitive

| The sensor/peripheral... | Represent it as | Emits |
|---|---|---|
| presents a fixed voltage to the MCU | `voltage_source` | `V ... DC` |
| **is** a variable resistance | `resistor` in a divider | `R ...` |
| draws current / is a bus device | `generic_load` (+ I2C pull-ups) | `I ... DC` |

If more than one fits, prefer the one that makes the scored assertion testable:
a thermistor whose temperature reading matters is a divider (assert the tap); an
I2C humidity sensor whose humidity reading is out of scope is a `generic_load`
(assert the rail/bus electrical envelope).

## The `faithful` vs `abstracted` tag

Every build-spec circuit carries exactly one tag. Child B (#106) records it per
spec; child C (#107) surfaces it per result.

- **`faithful`** — built from a **real modelled part**: an MCU from
  `registry/mcu/` (ESP32-C3, ESP32-WROOM-32, STM32F103, ATmega328P), an imported
  device with a real SPICE model/subcircuit (`registry/imported/` BJTs, MOSFETs,
  diodes, LM358, LDO), or plain passives. The simulation exercises real device
  physics, so a `sim_assertion` tests the actual modelled behavior.

- **`abstracted`** — uses at least one **stand-in** from the three primitives
  above for a sensor/peripheral that is not a datasheet-exact SPICE model. This
  includes the #105 behavioral sensor models (thermistor/LDR as parameterized
  resistors, the electrical-only I2C sensor stub). The simulation exercises the
  agent's **wiring and topology reasoning** (correct divider, correct rail/ground,
  correct pull-ups, correct ADC pin) against a stand-in, NOT the sensor's internal
  physics.

Rule of thumb: a circuit is `faithful` only if **every** non-passive part in it is
a real modelled part. One documented stand-in makes the whole circuit
`abstracted`. This is deliberately conservative — it never overstates fidelity.

### Tag placement (for child B)

The tag is spec-level metadata (not part of the AIR IR). Child B stores it in the
spec's criteria JSON alongside `required_components`, `connectivity`, `erc_clean`,
`sim_assertion`, and `firmware_intent`, e.g.:

```json
{
  "id": "arduino_thermistor_read",
  "fidelity_tag": "abstracted",
  "abstraction": {
    "part": "NTC_10K_3977",
    "primitive": "resistor_divider",
    "reason": "thermistor is a behavioral parameterized resistor, not a datasheet thermal model"
  },
  "sim_assertion": { "net": "therm_sense", "min_v": 2.475, "max_v": 2.525 }
}
```

A spec whose only non-passive part is the MCU + a real modelled device is
`faithful` and omits the `abstraction` block.

## What is honestly NOT covered

- Abstracted-sensor circuits do not validate a sensor's internal physics — only
  its electrical footprint (resistance-at-condition, supply draw, bus topology).
- No executable firmware (M8). Firmware intent (ADC/GPIO/PWM pin assignments +
  declarative tasks) is what a spec tests, not running code.
- The behavioral resistance laws (NTC Beta equation, LDR gamma curve) are
  approximations; exact values come from the datasheet R-T / R-illuminance tables.
  Each ground-truth circuit's window is sized to absorb the documented divergence
  (see `tests/ground_truth/thermistor_divider_hot/derivation.md`).

## References

- Epic: #104 (generative build benchmark, hybrid fidelity + validate/simulate).
- Registry entries: `registry/mcu/atmega328.json`,
  `registry/imported/ntc_10k_3977.json`, `registry/imported/ldr_gl5528.json`,
  `registry/imported/i2c_sensor_stub.json`.
- Micro-verification sims: `tests/ground_truth/{atmega328_adc_divider,
  thermistor_divider,thermistor_divider_hot,photoresistor_divider,
  photoresistor_divider_dark,i2c_sensor_stub}/`.
- Ground-truth discipline: `tests/ground_truth/README.md` (#41), registry
  provenance rule (#32).
