# Validation rules inventory

This table enumerates **every** rule in the AIR validator, read line-by-line from
the Python oracle `packages/core/src/air/validation.py` (issue #8). It is the
contract the TypeScript port `packages/air-ts/src/validate/` reproduces exactly:
same diagnostic **code**, **severity**, **domain**, message text, target
(`related_elements`) and — critically — **emission order** (Python emits in
document order; so does the port).

Two things keep this doc honest:

- **Coded rules** (below) must equal the distinct **validation-owned** diagnostic
  codes in `registry/diagnostics.json` (`owner == "validation"`), which is
  **47**. The port's coverage ledger test
  (`tests/validate_mutation.test.ts` → "coverage ledger vs registry") asserts the
  same 47 are each fired by the corpus or a mutation, or are documented
  unreachable — so a doc/source/registry mismatch fails CI, not review.
- **Un-coded structural checks** (second table) are control-flow gates and
  helpers that change *which* coded diagnostics fire but emit no code of their
  own. They are documented so the count "47 codes" is not mistaken for "47 lines
  of logic": the validator also carries the checks below.

## Coded rules (47) — one row per validation-owned diagnostic code

| # | Code | Severity | Domain | Source function | Trigger condition |
|---|------|----------|--------|-----------------|-------------------|
| 1 | `INVALID_ROOT` | error | schema | `validate_tree` | Root element tag is not `<system>` (short-circuits: no further schema checks run). |
| 2 | `MISSING_SYSTEM_ATTR` | error | schema | `validate_tree` | `<system>` is missing a required attribute `name` or `ir_version` (one per missing attr, `name` first). |
| 3 | `MISSING_SECTION` | error | schema | `validate_tree` | A top-level section `<metadata>`/`<nets>`/`<components>`/`<tests>`/`<simulation_profiles>` is absent (one per missing section, in that order). |
| 4 | `DUPLICATE_ID` | error | schema | `validate_tree` | Two elements in a collection (`net`/`component`/`test`/`profile`) share an `id` (checked in that collection order). |
| 5 | `NO_NETS` | error | semantic | `validate_ir` | The design defines zero nets. |
| 6 | `MISSING_GROUND` | error | electrical | `validate_ir` | No net has `role == "ground"`. |
| 7 | `DUPLICATE_COMPONENT_ID` | error | semantic | `validate_ir` | Non-empty component ids are not unique. **Unreachable from parsed XML** (the parser keys components by id in a dict, so duplicates collapse; the raw-tree `DUPLICATE_ID` fires instead). Retained verbatim to mirror the oracle. |
| 8 | `MISSING_COMPONENT_ID` | error | semantic | `validate_ir` | A component has a falsy `id` (a no-id component is stored under the `""` key and iterated). |
| 9 | `MISSING_COMPONENT_TYPE` | error | semantic | `validate_ir` | A component has a falsy `type`. |
| 10 | `UNKNOWN_NET` | error | semantic | `validate_ir` | A component pin references a `net` that is not defined in `<nets>`. |
| 11 | `MISSING_POWER_OR_GROUND` | error | power | `validate_ir` | A non-passive component of type `mcu` or `ldo` does not connect to BOTH a power net and a ground net. |
| 12 | `UNSUPPORTED_SPICE_TYPE` | warning | compiler | `validate_ir` | A component's type is not in `SUPPORTED_SPICE_TYPES` and is not `mcu` (v0.1 SPICE compiler cannot emit it). |
| 13 | `POWER_DOMAIN_UNKNOWN_NET` | error | power | `validate_ir` | A `<power_domains>` domain references an undefined net. |
| 14 | `UNKNOWN_ANALOG_COMPONENT` | error | analog | `validate_ir` | An analog subsystem `<uses>` a component id that does not exist. |
| 15 | `UNKNOWN_PROBE_NET` | error | analog | `validate_ir` | An analog probe references an undefined net. |
| 16 | `UNKNOWN_FIRMWARE_TARGET` | error | firmware | `validate_ir` | A firmware project targets a component id that does not exist. |
| 17 | `UNKNOWN_BINDING_COMPONENT` | error | firmware | `validate_ir` | A firmware binding references a component id that does not exist. |
| 18 | `UNKNOWN_BINDING_NET` | error | firmware | `validate_ir` | A firmware binding references a net that does not exist. |
| 19 | `UNKNOWN_TASK_TARGET` | error | firmware | `validate_ir` | A firmware task targets a project id that does not exist. |
| 20 | `TEST_SETUP_UNKNOWN_COMPONENT` | error | test | `validate_ir` | A test setup key `current:<id>` / `load_step:<id>` names a component that does not exist. |
| 21 | `TEST_SETUP_UNKNOWN_NET` | error | test | `validate_ir` | A test setup key (not a `current:`/`load_step:` special) is not a defined net. |
| 22 | `ASSERT_UNKNOWN_NET` | error | test | `validate_ir` | A test assertion references an undefined net. |
| 23 | `ASSERT_UNKNOWN_COMPONENT` | error | test | `validate_ir` | A test assertion references a component that does not exist. |
| 24 | `UNSUPPORTED_BACKEND` | error | simulation | `validate_ir` | A profile backend is neither `ngspice` nor `renode`. |
| 25 | `PROFILE_UNKNOWN_TEST` | error | simulation | `validate_ir` | A profile references a test id that does not exist. |
| 26 | `PROFILE_UNKNOWN_SUBSYSTEM` | error | simulation | `validate_ir` | A profile includes a subsystem id that does not exist. |
| 27 | `I2C_UNKNOWN_NET` | error | interface | `_validate_i2c` | The I2C interface's `sda` or `scl` child names a net that is not defined. |
| 28 | `I2C_PULLUPS_NOT_DECLARED` | error | interface | `_validate_i2c` | Fewer than two `<pullup>` entries are declared (SDA + SCL required). |
| 29 | `I2C_PULLUP_UNKNOWN_NET` | error | interface | `_validate_i2c` | A pullup's `net` is not a defined net. |
| 30 | `I2C_PULLUP_UNKNOWN_RAIL` | error | interface | `_validate_i2c` | A pullup's `to` rail is not a defined net. |
| 31 | `I2C_PULLUP_NOT_POWER_RAIL` | error | interface | `_validate_i2c` | A pullup's `to` rail exists but its role is not `power`. |
| 32 | `I2C_VOLTAGE_MISMATCH` | error | interface | `_validate_i2c` | A pullup rail differs from the controller MCU's `3V3` pin net (one per mismatched pullup). |
| 33 | `I2C_PULLUP_TOO_WEAK` | warning | interface | `_validate_i2c` | Pullup resistance > 2200 Ω at speed > 100 kHz, OR > 10 kΩ at any speed. |
| 34 | `I2C_PULLUP_TOO_STRONG` | warning | interface | `_validate_i2c` | Pullup resistance < 1000 Ω (and not already flagged weak). |
| 35 | `UNKNOWN_MCU_PART` | error | pin | `_validate_mcu` | The MCU's `part` is missing or not in the registry (`MCUS`); short-circuits the rest of the MCU checks. |
| 36 | `MISSING_MCU_POWER_PIN` | error | pin | `_validate_mcu` | A registry-required power pin (key of the MCU's `power_pins`) is absent from the component. |
| 37 | `UNKNOWN_MCU_PIN` | warning | pin | `_validate_mcu` | A non-power pin's name is not present in the MCU registry `pins` map. |
| 38 | `UNSUPPORTED_PIN_FUNCTION` | error | pin | `_validate_mcu` | A pin declares a `function` not in the registry's supported set for that pin (`expected.supported` = `sorted(...)`). |
| 39 | `MISSING_REQUIRED_PIN` | error | registry | `_validate_component_registry_rules` | A component is missing a `required_pins` entry from its type spec. |
| 40 | `MISSING_REQUIRED_VALUE` | error | registry | `_validate_component_registry_rules` | A `value_required` type has no `<value>`. |
| 41 | `MISSING_REQUIRED_PROPERTY` | error | registry | `_validate_component_registry_rules` | A component is missing a `required_properties` entry from its type spec. |
| 42 | `MISSING_REQUIRED_VALUE_OR_PROPERTY` | error | registry | `_validate_component_registry_rules` | None of a type's `required_any` is satisfied (`value` present, or a named property present). |
| 43 | `LOAD_CURRENT_UNSPECIFIED` | warning | electrical | `_validate_generic_load` | A `generic_load` has neither a `<value>` nor a `current` property. |
| 44 | `RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT` | error | power | `_validate_load_budget` | Summed load on an LDO's `out` net exceeds the regulator's `iout_max`. |
| 45 | `SOURCE_OVERLOADED` | error | power | `_validate_load_budget` | Total current draw on a `voltage_source`'s first-pin net exceeds its `i_max`. |
| 46 | `ADC_INPUT_EXCEEDS_VREF` | error | electrical | `_validate_adc_binding` | An MCU ADC binding's net has an estimated voltage above the peripheral `vref`. |
| 47 | `UNDEFINED_SPICE_MODEL` | error | compiler | `_validate_spice_models` | A component names a `spice_subckt` not in `BUILTIN_SPICE_SUBCKTS` (any type), OR a `spice_model` not in `BUILTIN_SPICE_MODELS` for a modelled type (`bjt`/`mosfet`/`diode`). One diagnostic per unbacked reference (issue #55). |

**Coded-rule count: 47** — equal to the validation-owned (`owner == "validation"`)
codes in `registry/diagnostics.json`. (The registry lists 56 active codes total;
the other 9 are owned by `simulator` (4), `runners` (4), and `spice` (1) — out of
scope for this port.)

## Un-coded structural checks (control-flow gates & helpers)

These emit no diagnostic code themselves but govern which coded diagnostics fire
and with what values. They are part of the ported logic and are reproduced
faithfully in `packages/air-ts/src/validate/rules.ts`.

| Location | Kind | What it does |
|----------|------|--------------|
| `validate_tree` (root check) | control-flow gate | On a non-`<system>` root, emits `INVALID_ROOT` and **returns immediately**, suppressing every other schema check. |
| `validate_ir` (`_MODELLED_SPICE_TYPES` = `{bjt, mosfet, diode}`) | membership gate | Restricts the `spice_model` half of `UNDEFINED_SPICE_MODEL` to those types; the `spice_subckt` half applies to any type. |
| `validate_ir` (`type in {mcu, ldo}` gate) | control-flow gate | `has_ground`/`has_power` are computed for every non-passive component, but `MISSING_POWER_OR_GROUND` only fires for `mcu`/`ldo`. |
| `validate_ir` (`type not in PASSIVE_TYPES`) | membership gate | Skips the power/ground connectivity check for `resistor`/`capacitor`. |
| `_validate_i2c` `get_val` | helper | Resolves `speed` from a direct `data` key, else a matching `<property name="speed">`, else `"100kHz"`; feeds the too-weak threshold. |
| `_validate_i2c` (speed/value thresholds) | branching logic | Chooses between `I2C_PULLUP_TOO_WEAK` (>2200 Ω @ >100 kHz, or >10 kΩ) and `I2C_PULLUP_TOO_STRONG` (<1000 Ω); a mid-range value emits nothing. Unparseable speed/values are swallowed. |
| `_validate_i2c` (controller `3V3` heuristic) | helper | Uses the controller MCU's `3V3` pin net as the reference rail for `I2C_VOLTAGE_MISMATCH`; absent pin ⇒ no mismatch check. |
| `_validate_load_budget` (`net_loads` accumulation) | helper | Sums `generic_load` currents per net (value or `current` property). |
| `_validate_load_budget` (LDO propagation) | helper | Propagates each LDO's `out`-net load plus quiescent `iq` onto its `in` net (one pass), before the source-overload check. |
| `_validate_adc_binding` (early returns) | control-flow gate | Bails unless the binding's component is a registry MCU whose named peripheral is a dict with a parseable `vref`, and the bound net exists. |
| `_estimate_net_voltage` | helper | Estimates a net's voltage from ground (0 V), nominal-voltage nets, LDO `vout`, else a one-node resistor-divider estimate; `None` ⇒ `ADC_INPUT_EXCEEDS_VREF` does not fire. |
| `_as_list` | helper | Coerces a missing / dict / list interface datum into a list of dicts (used for `pullup` and `property`). |
| `has_errors` | helper | Derives the `success` flag in `diagnostics.json` (`success = not has_errors(...)`). |

## Parity notes (behaviors replicated, not "fixed")

- **Separate id counters.** `validate_tree` and `validate_ir` each use a fresh
  `DiagnosticBuilder`, so both start at `diag_00001`; if both emit, the ids
  collide. The exporter concatenates `validate_tree(tree) + validate_ir(ir)`
  without renumbering. In every committed corpus design `validate_tree` emits
  nothing, so ids run `00001..` from `validate_ir`; the collision path is dormant
  but preserved verbatim (`src/validate/diagnostics.ts`).
- **`DUPLICATE_COMPONENT_ID` is dead from XML input** in both the oracle and the
  port (see rule 7). Retained, not deleted — the oracle keeps it.
- **`%.3g` / `%.6g` message numerics** (`SOURCE_OVERLOADED`, `RAIL_LOAD…`,
  `ADC_INPUT_EXCEEDS_VREF`) reuse the shared `formatG` (`%g` printf semantics), so
  e.g. a 0.201 A draw renders `0.201A` byte-for-byte.
- **`UNSUPPORTED_PIN_FUNCTION`** stores `expected.supported = sorted(...)`. The
  registry keeps pin functions as arrays; the port applies `sorted()` at the emit
  site (code-point order) exactly where the oracle does.
