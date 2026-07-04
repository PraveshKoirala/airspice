# Oracle ground-truth validation (issue #41)

Hand-derived analytic circuits that audit the Python oracle against **physics**,
independently of the golden-corpus parity path. Every expected value here is
worked out by hand (or cited from a datasheet) in the circuit's `derivation.md`
**before** the oracle was ever run — nothing is copied from simulator output.
That is the whole point: parity testing proves ports match the oracle; this
proves the oracle matches reality.

Run it (needs real ngspice on PATH or `AIR_NGSPICE`):

```
PYTHONPATH=packages/core/src python -m pytest tests/test_ground_truth.py -v
```

Each `<circuit>/` has `design.air.xml`, `derivation.md` (the math), and
`expected.json` (machine-readable windows + physics-justified tolerances). The
runner `tests/test_ground_truth.py` hard-fails if ngspice is missing or if any
`pass` circuit's report shows `builtin_dc_fallback` (a fallback number is not
ground-truth evidence — see #55).

## Circuit inventory

| Circuit | Quantity | Hand-derived value | Basis | Outcome |
|---|---|---|---|---|
| `resistive_divider` | divider tap | 3.000 V | 9·10k/30k | pass |
| `loaded_divider_thevenin` | loaded tap | 4.000 V | V_th=6V, R_th=5k, ÷10k | pass |
| `current_source_resistor` | node V | 4.400 V | Ohm: 2 mA·2.2k | pass |
| `series_ladder` | two taps | 8.000 V / 4.000 V | I=2 mA ladder | pass |
| `ldo_regulation_inrange` | reg out | 3.300 V | min(3.3, 5−0.2) | pass |
| `ldo_dropout` | dropout out | 3.200 V | min(3.3, 3.4−0.2) | pass |
| `diode_forward_drop` | Vf @1 mA | 0.655 V | Shockley, generic .model D | pass |
| `bjt_ce_bias` | collector V | 4.000 V | I_C=β·I_B=1 mA, 5−1 | pass |
| `rc_step_response` | V@τ,2τ,5τ | 2.086 / 2.853 / 3.278 V | 3.3·(1−e^−t/τ) | pass |
| `pwm_rc_average` | filtered avg | **1.650 V (want)** | D·Vstep, D=0.5 | **expected-fail #59** |
| `rc_lowpass_fc` | −3 dB @ fc | **0.7071 V (want)** | 1/√2 at fc=995 Hz | **expected-fail #62** |
| `led_forward_drop` | red LED Vf | **1.8–2.2 V (want)** | LED datasheet | **expected-fail #55** |
| `zener_clamp` | clamp V | **5.1 V (want)** | Zener BV | **expected-fail #55** |
| `inverting_opamp_gain` | Vout | **−2.200 V (want)** | −Rf/Rin·Vin | **expected-fail #55** |

9 passing + 5 documented expected-failures = 14 circuits.

## Findings (oracle disagreements → filed issues)

- **#59** — firmware→SPICE PWM stimulus emits the wrong duty cycle: the firmware
  ON-time is mapped to the PULSE plateau width while fixed 1 µs edges are added,
  so a 50 %-intended PWM averages to 60 % (1.98 V instead of 1.65 V). Caught by
  `pwm_rc_average`.
- **#62** — the compiler emits only `.tran` with DC sources, never `.ac`, so
  frequency-domain checks (RC −3 dB at fc, roll-off) are unverifiable. Caught by
  `rc_lowpass_fc`.
- **#55** (pre-existing) — SPICE compiler emits netlists referencing undefined
  models/subckts; ngspice exits non-zero and the simulator silently downgrades to
  the DC fallback reporting a hollow `passed`. Blocks any circuit needing a
  part-specific model: LED, Zener, op-amp. Captured as the three `#55`
  expected-failures, which become acceptance tests once #55 is fixed.
