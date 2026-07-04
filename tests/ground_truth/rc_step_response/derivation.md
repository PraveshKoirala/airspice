# RC step response — value at t = tau, 2tau, 5tau

## Circuit
```
  drive (0 -> 3.3V step) --[R_S = 1k]-- cap --[C_S = 1uF]-- gnd
```
The `drive` net is an MCU GPIO. The compiler's firmware→SPICE translation
(`air/spice.py::_mcu_stimulus_lines`) turns a `write_gpio high` with a following
`delay` into `PULSE(0 3.3 0 1u 1u <ton> <period>)`. Here `ton = 1 s` and
`period = 2 s`, both vastly larger than the 5 ms simulation window, so within the
run the source is a single 0→3.3 V step at t≈0 (1 µs rise, negligible vs the
1 ms time constant). ngspice computes the t=0 operating point at the PULSE
initial value 0 V, so the capacitor starts discharged (V_cap(0)=0).

## Constants
Step amplitude `V_step = 3.3 V` (GPIO logic high, fixed by the compiler).

Time constant:

    tau = R_S · C_S = 1000 Ω · 1e-6 F = 1.000e-3 s = 1.000 ms

Sample times: t = tau, 2·tau, 5·tau = 1 ms, 2 ms, 5 ms.

## Hand derivation (capacitor charging law)
    V_cap(t) = V_step · (1 − e^(−t/tau))

**t = tau (t/tau = 1):**
    e^(−1)   = 0.3678794
    1 − e^-1 = 0.6321206
    V_cap    = 3.3 · 0.6321206 = 2.08600 V

**t = 2·tau (t/tau = 2):**
    e^(−2)   = 0.1353353
    1 − e^-2 = 0.8646647
    V_cap    = 3.3 · 0.8646647 = 2.85339 V

**t = 5·tau (t/tau = 5):**
    e^(−5)   = 0.00673795
    1 − e^-5 = 0.9932621
    V_cap    = 3.3 · 0.9932621 = 3.27776 V

## Expected values
| t      | t/tau | V_cap (hand)  |
|--------|-------|---------------|
| 1 ms   | 1     | **2.086 V**   |
| 2 ms   | 2     | **2.853 V**   |
| 5 ms   | 5     | **3.278 V**   |

The runner reads the probed waveform CSV and samples the nearest point to each
time (transient step = 1 µs, so the nearest sample is within 1 µs of the target).

## Tolerance
Error sources and their size:
- **Finite step rise (1 µs) and its ≈0.5 µs effective delay** shifts the curve by
  ≤0.5 µs, i.e. ≤0.05 % of tau → ≤2 mV near t=tau. Negligible.
- **Transient timestep / sampling** — the nearest recorded sample can be up to the
  print step away in time; near t=tau the slope is `V_step/tau·e^-1 ≈ 1213 V/s`,
  so a 1 µs timing error → ≈1.2 mV. Negligible.
- **ngspice reltol** ≈ 0.1 % of the value → ≈2–3 mV.

A **±3 % of V_step window (±0.099 V ≈ ±0.10 V)** on each sampled value covers all
of the above with margin and still cleanly distinguishes the three points from
each other (they differ by 0.4–0.77 V) and from the final value 3.278 V. Windows:
- t=tau : **1.986 V – 2.186 V**
- t=2tau: **2.753 V – 2.953 V**
- t=5tau: **3.178 V – 3.378 V** (upper clamped at 3.3 V physical max is fine; the
  exact value 3.278 V sits inside)

These are exponential-law values, hand-computed — not read from any simulation.
