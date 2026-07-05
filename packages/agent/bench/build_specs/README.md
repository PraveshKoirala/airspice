# Build-benchmark spec corpus (issue #106)

The list the agent gets **tested on** for the generative half of the pitch:
*describe a device in plain English, the agent builds a valid, simulatable
circuit.* Child B of epic #104. Depends on #105 (ATmega328 + sensor models +
the `faithful`/`abstracted` abstraction convention in
`docs/build_bench_abstraction.md`).

Each spec is a JSON record under `specs/`. The scorer (#107, child C) consumes
these records plus the connectivity vocabulary below; every criterion is
**machine-checkable by objective code** — structure on the parsed AIR model, ERC
diagnostics from `air.validation`, and (where present) a real ngspice
`sim_assertion`. **No LLM judge.**

For 12 representative specs (at least one per category) a **golden build** —
a known-good `design.air.xml` — lives in `golden/<spec_id>/`. Each golden is run
through `validate + simulate + the scorer-style criteria checks` by
`tests/test_build_specs.py` and must PASS its own criteria. That proves the
criteria are satisfiable and not mis-specified: a spec whose golden cannot pass
its own criteria is a broken spec.

## The spec schema

```jsonc
{
  "id":            "esp32c3_lipo_divider_adc",   // unique, stable, snake_case
  "title":         "LiPo battery monitor on ADC",
  "category":      "adc_frontend",               // see category list below
  "prompt":        "…natural-language device spec a maker would say…",
  "mcu":           "esp32_c3",                    // esp32_c3|esp32_wroom_32|stm32_f103|atmega328
  "fidelity":      "faithful",                    // faithful | abstracted (per #105)
  "abstraction": {                                // present iff fidelity == abstracted
    "part":      "NTC_10K_3977",
    "primitive": "resistor_divider",              // voltage_source | resistor_divider | generic_load
    "reason":    "thermistor is a behavioral parameterized resistor, not a datasheet thermal model"
  },
  "criteria": {
    "required_components": [                       // types + minimum counts
      { "type": "mcu",      "count": 1, "part": "ESP32-C3" },
      { "type": "resistor", "count": 2 }
    ],
    "connectivity": [                              // structural patterns, vocabulary below
      "series_divider(high=<power>, tap=<adc_net>, low=gnd)",
      "adc_input(net=<adc_net>, mcu=ESP32-C3)"
    ],
    "firmware_intent": [ "read_adc(net=<adc_net>)", "log" ],
    "erc_clean": true,
    "sim_assertion": { "net": "battery_sense", "min_v": 1.02, "max_v": 1.06 }
  },
  "turn_budget": 4,
  "golden": "golden/esp32c3_lipo_divider_adc/design.air.xml"   // present iff a golden exists
}
```

`sim_assertion` is optional. When present it is a DC/settled voltage window on a
named net that the built design must simulate to on **real ngspice**
(`require_backend: ngspice`; a `builtin_dc_fallback` result does not count — see
`tests/test_ground_truth.py` #55). Nets named in `sim_assertion` and
`connectivity` use `<placeholder>` tokens the agent chooses; the scorer resolves
the placeholder to whatever net the agent actually used and checks the pattern
holds on that net.

## Connectivity vocabulary (for #107's scorer)

The scorer matches these patterns against the parsed AIR model
(`air.parser.parse_string` → `SystemIR`). `<...>` are placeholders the agent
picks (a net id or a component id); `gnd` means "a net whose `role == ground`";
`<power>` means "a net whose `role == power`". Each predicate is a pure
structural check — no simulation, no LLM.

| Predicate | Holds when |
|---|---|
| `series_divider(high=<A>, tap=<T>, low=<B>)` | two `resistor`s R1,R2 with R1 across nets {A,T} and R2 across nets {T,B}; T is the shared tap. |
| `adc_input(net=<T>, mcu=<PART>)` | the MCU (`type=mcu`, `part=PART`) has a pin on net T whose `function` is an `ADC*` token valid for that pin in the registry. |
| `gpio_output(net=<N>, mcu=<PART>)` | the MCU has a pin on net N whose `function` is a GPIO/GPIO_OUT/PWM token. |
| `gpio_input(net=<N>, mcu=<PART>)` | the MCU has a pin on net N whose `function` is a GPIO token (a digital input; the same GPIO tokens serve input and output in the registry). |
| `pullup(net=<N>, to=<RAIL>)` | a `resistor` connects net N to a `role=power` net RAIL. |
| `series_element(type=<TY>, a=<A>, b=<B>)` | a component of type TY has one pin on net A and another on net B. |
| `current_limit_resistor(gpio=<G>, load=<L>)` | a `resistor` in series between a GPIO-driven net G and load net L (LED/etc.). |
| `low_side_switch(sw=<TY>, control=<C>, load=<L>)` | a switch of type TY (`bjt`/`mosfet`) with its control pin (B/G) on net C, the switched pin (C/D) on net L, and the common pin (E/S) on `gnd`. |
| `high_side_switch(sw=<TY>, control=<C>, load=<L>, rail=<R>)` | switch TY with common pin (S) on a `role=power` net R, switched pin (D) on load net L, control pin on C. |
| `flyback_diode(across=<L>, rail=<R>)` | a `diode` with anode on inductive-load net L and cathode on rail R (freewheeling across the coil/winding). |
| `rc_lowpass(in=<I>, out=<O>)` | a `resistor` across {I,O} and a `capacitor` across {O, gnd}; O is the filtered output. |
| `regulator(in=<VIN>, out=<VOUT>, gnd=gnd)` | an `ldo` with `in` pin on VIN, `out` pin on VOUT, `gnd` pin on a ground net. |
| `mcu_powered(mcu=<PART>, rail=<R>)` | the MCU power pin is on net R (`role=power`) and its ground pin on a ground net. |
| `series_diode(anode=<A>, cathode=<C>)` | a `diode` with anode on A, cathode on C (e.g. reverse-polarity protection in the supply path). |
| `i2c_bus(sda=<SDA>, scl=<SCL>, rail=<R>)` | an `<interface type=i2c>` with SDA on SDA, SCL on SCL, and two `pullup`s to a `role=power` net R (validation enforces the pull-ups). |
| `load_on_rail(rail=<R>)` | a `generic_load` with one pin on a `role=power` net R (models a peripheral's supply draw). |
| `decoupling_cap(net=<N>)` | a `capacitor` across {N, gnd} (bypass / anti-alias). Optional/advisory — never the sole criterion. |

A placeholder used in more than one predicate (or in `sim_assertion`) must
resolve to the **same** net across all of them — that is how "the divider tap is
the ADC net" is checked: `series_divider(..., tap=<T>)` **and**
`adc_input(net=<T>, ...)` share `<T>`.

## How the scorer checks each criterion type

- **required_components** — parse the design, group components by `type`, assert
  `count(type) >= required` and (if `part` given) that at least that many carry
  the named `part`. Objective.
- **connectivity** — evaluate each predicate above against the net/pin graph;
  every predicate must hold, with placeholders unified. Objective.
- **firmware_intent** — assert the declarative firmware ops exist: a
  `read_adc` task bound to the ADC net, a `write_gpio`/PWM op on the control pin,
  a `log`, etc. (structural on `ir.firmware_tasks` / `ir.firmware_bindings`).
  Declarative today (M8 is executable firmware) — the scorer checks the op is
  present and bound to the right pin/net, not that code runs.
- **erc_clean** — `not has_errors(validate_tree(tree) + validate_ir(ir))`.
  Objective.
- **sim_assertion** — `simulate_analog(ir, profile, out)`; the named net's
  settled voltage must land in `[min_v, max_v]` on `backend == ngspice`.
  Objective, real physics.

## Fidelity tagging (per #105)

`faithful` only if **every** non-passive part is a real modelled part: an MCU, a
`bjt`/`mosfet`/`diode` (the compiler emits a real generic device `.model` the
simulator integrates — see `tests/ground_truth/{bjt_ce_bias,diode_forward_drop}`
and `spice.BUILTIN_MODEL_CARDS`), or a behavioral `ldo`. `abstracted` if the
circuit uses one of the three #105 stand-ins (`voltage_source`,
`resistor`-as-sensor, `generic_load`) for a sensor/peripheral that has no
datasheet-exact SPICE model — thermistor/LDR (resistor), a fixed analog-sensor
or an op-amp stage output (`voltage_source`), an I2C device or module draw
(`generic_load`). One documented stand-in makes the whole circuit `abstracted`.
The tag is conservative and never overstates fidelity.

### Op-amp note (LM358)

The registry LM358 is `type="opamp"` with `spice_subckt="LM358"`, for which the
compiler emits **no** `.subckt` — so a design containing it fails validation with
`UNDEFINED_SPICE_MODEL` (see `air.validation._validate_spice_models`) and can
neither pass `erc_clean` nor simulate. Op-amp specs therefore model the **output
the op-amp stage produces** with the #105 `voltage_source` stand-in (primitive 1)
and are tagged `abstracted`. This tests the agent's stage/ADC wiring against a
conditioned-signal source, honestly, rather than pretending a faithful LM358
model exists. When a real LM358 subcircuit is imported (a future part-model
issue) these can be upgraded to `faithful`.

## Categories

`adc_frontend`, `led_driver`, `switching`, `power`, `filter_pwm`, `opamp`,
`button`, `sensor_node`, `composite`.

## Running the golden-build validation

```
# from repo root, with real ngspice on PATH or AIR_NGSPICE set
PYTHONPATH=packages/core/src python -m pytest tests/test_build_specs.py -v
```

The test loads every `specs/*.json` (schema + buildability sanity), and for each
spec that declares a `golden`, parses the golden design, runs the same
validate + connectivity + required_components + firmware_intent + sim checks the
scorer will run, and asserts the golden PASSES its own criteria. A golden that
fails its own criteria fails the suite loudly.
