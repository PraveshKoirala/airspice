# PWM + RC average voltage vs duty cycle — PASS (oracle bug #59 fixed)

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

## The historical bug (#59) and the fix
Before #59 was fixed, the compiler's firmware→SPICE translator
(`air/spice.py::_mcu_stimulus_lines`) emitted:

    V_STIM_U_MCU_GPIO2 pwm 0 PULSE(0 3.3 0 1u 1u 5us 10us)

i.e. `PULSE(V1=0 V2=3.3 TD=0 TR=1u TF=1u PW=5us PER=10us)`. It mapped the firmware
ON-time (5 µs) straight to the SPICE **plateau width `PW`** with hardcoded 1 µs
rise and fall. But the pulse is high across `PW + TR + TF`, so the time-average of
that trapezoid was:

    V_avg(buggy) = V2 · (PW + (TR+TF)/2) / PER
                 = 3.3 · (5us + 1us) / 10us
                 = 3.3 · 0.60
                 = 1.980 V         (an effective 60 % duty)

Measured through the RC in real ngspice: **1.98076 V** — an effective 60 % duty,
not the intended 50 %; the absolute error was `1us/period`, worsening as the
period shrank.

**Fix (oracle-first).** `_pwm_pulse` now compensates the ramp area so the emitted
trapezoid's high-area equals `ton`: it picks `PW = ton − (TR+TF)/2 = 5us − 1us =
4us`, emitting

    V_STIM_U_MCU_GPIO2 pwm 0 PULSE(0 3.3 0 1us 1us 4us 10us)

whose average is `V2 · (4us + 1us) / 10us = 3.3 · 0.50 = 1.650 V` — the intended
duty, independent of frequency. The oracle's *averaging physics* was always
correct; only the firmware→PULSE duty translation was wrong, and it now matches
the hand math `V_avg = D·V_step = 0.50 · 3.3 = 1.650 V`.

## Disposition
**Pass**, oracle bug **#59** fixed oracle-first. The runner asserts:
1. ngspice really ran (`backend == ngspice`), and
2. the settled mean of `avg` (t ≥ 5 ms) falls in the correct 50 %-duty window
   [1.55, 1.75] V around the hand-derived 1.650 V.

The window is UNCHANGED from the pre-fix `would_pass` value — the derivation is
the contract; the fix moves the oracle onto it rather than the window onto the
oracle.

## Tolerance
Pass window: ±3 % of V_step → [1.550, 1.750] V, from the ripple/settling budget
(ripple ≈ ±4 mV, settling < 0.1 mV after 10·tau). This is the same window that
was the pre-fix `would_pass` target; it was never tuned to the 1.98 V defect.
