# PWM + RC average voltage vs duty cycle — EXPECTED FAILURE (oracle bug #59)

## Circuit
```
  pwm (0/3.3V square, 100kHz, intended 50% duty) --[R_F = 10k]-- avg --[C_F = 100nF]-- gnd
```
`pwm` is an MCU GPIO. The firmware task requests a 100 kHz square wave with an
ON-time of 5 µs, i.e. an **intended duty D = ton/period = 5 µs / 10 µs = 0.50**.
The RC filter time constant is `tau = R_F·C_F = 10k·100nF = 1 ms`, 100× the PWM
period, so it settles to the time-average of the PWM.

## Hand derivation (the CORRECT ground truth)
A low-pass whose tau ≫ PWM period settles to the input's time-average. For a
rail-to-rail PWM between 0 and V_step at duty D:

    V_avg = D · V_step = 0.50 · 3.3 V = **1.650 V**

This is the physically correct answer for a 50 %-duty PWM and it is the value we
WOULD assert. Window ±3 % of V_step → **[1.550, 1.750] V**.

## What the oracle actually produces, and why it is wrong (bug #59)
The compiler's firmware→SPICE translator
(`air/spice.py::_mcu_stimulus_lines`) emits:

    V_STIM_U_MCU_GPIO2 pwm 0 PULSE(0 3.3 0 1u 1u 5us 10us)

i.e. `PULSE(V1=0 V2=3.3 TD=0 TR=1u TF=1u PW=5us PER=10us)`. It maps the firmware
ON-time (5 µs) to the SPICE **plateau width `PW`**, and hardcodes 1 µs rise and
fall. But the pulse is high across `PW + TR + TF`, so the time-average of the
emitted trapezoid is:

    V_avg(emitted) = V2 · (PW + (TR+TF)/2) / PER
                   = 3.3 · (5us + 1us) / 10us
                   = 3.3 · 0.60
                   = 1.980 V         (an effective 60 % duty)

Measured through the RC in real ngspice: **1.98076 V** — matching the trapezoid
average, confirming the emitted duty is 60 %, not the intended 50 %. The absolute
duty error is `1us/period` and grows as the PWM period shrinks.

The oracle's *averaging physics* is correct; the defect is purely in the
firmware→PULSE duty translation. Hand math (V_avg = D·V_step, D = ton/period =
0.50 → 1.650 V) holds; the oracle disagrees, so per the issue #41 contract this
is a filed finding — **oracle bug #59** — and this circuit is marked
expected-failure. The expectation is NOT tuned to 1.98 V as if that were right.

## Disposition
**Expected failure**, linked to **#59**. The runner asserts:
1. ngspice really ran (`backend == ngspice`),
2. the mean lands at the oracle's actual (defective) ≈1.98 V — documenting the
   bug precisely, and
3. the mean does NOT fall in the correct 50 %-duty window [1.55, 1.75] V.

When #59 is fixed so `ton/period` maps to the true duty, the mean will move to
1.650 V and this circuit flips back to a passing `mean_check` on [1.55, 1.75] V.

## Tolerance
Correct-answer window (for after #59): ±3 % of V_step → [1.550, 1.750] V, from
the ripple/settling budget (ripple ≈ ±4 mV, settling < 0.1 mV after 10·tau).
Defect-documenting window: 1.98 V ± 0.03 V, covering the trapezoid average plus
ripple.
