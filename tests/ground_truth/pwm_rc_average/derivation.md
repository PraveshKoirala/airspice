# PWM + RC average voltage vs duty cycle

## Circuit
```
  pwm (0/3.3V square, 100kHz, 50% duty) --[R_F = 10k]-- avg --[C_F = 100nF]-- gnd
```
`pwm` is an MCU GPIO. The compiler emits a periodic high/low `write_gpio` as
`PULSE(0 3.3 0 1u 1u <ton> <period>)`. With `period = 10 us` and `ton = 5 us`
(the `delay` after the high write), the stimulus is a 100 kHz square wave with
duty cycle:

    D = ton / period = 5 us / 10 us = 0.50

## Constants
Logic swing `V_step = 3.3 V`. Filter time constant:

    tau = R_F · C_F = 10000 Ω · 100e-9 F = 1.000e-3 s = 1.000 ms

PWM period `T = 10 us`, so `tau / T = 1 ms / 10 us = 100`. The filter is 100×
slower than the PWM, so it passes the DC (average) term and heavily attenuates
the switching ripple.

## Hand derivation (DC average of a PWM through a low-pass)
A low-pass filter whose time constant is much larger than the PWM period settles
to the time-average of its input. For a rail-to-rail PWM between 0 and V_step:

    V_avg = D · V_step
          = 0.50 · 3.3 V
          = 1.650 V

**Settling.** The average is approached with the same tau; after the 10 ms run
(= 10·tau) the residual offset from the final value is `e^(−10) ≈ 4.5e-5`, i.e.
< 0.1 mV — fully settled. The runner averages the waveform over the second half
of the run (t > 5 ms = 5·tau) to reject the initial charging transient.

**Ripple amplitude (for the tolerance budget).** The peak-to-peak ripple on a
first-order RC fed by a PWM is approximately:

    V_ripple(pp) ≈ V_step · D · (1 − D) · (T / tau)
               = 3.3 · 0.5 · 0.5 · (10us / 1ms)
               = 3.3 · 0.25 · 0.01
               = 8.25 mV  (pp)   → about ±4 mV around the average

So the mean sits at 1.650 V with only a few-mV ripple riding on it.

## Expected value
**V_avg = 1.650 V** (duty-weighted average of the 3.3 V swing).

## Tolerance
- **Ripple:** ±4 mV about the mean (computed above). Averaging over the settled
  region removes almost all of it, but individual samples can sit ±4 mV off.
- **Incomplete settling:** < 0.1 mV after 10·tau. Negligible.
- **Rise/fall (1 us) asymmetry:** the emitted PULSE has equal 1 us TR and TF, so
  the duty is preserved to first order; any residual effect is a fraction of the
  ripple.
- **Solver reltol:** ≈ 0.1 % ≈ 1.6 mV.

A **±3 % of V_step (±0.099 V ≈ ±0.10 V)** window → **1.550 V – 1.750 V** covers
all of the above with wide margin, and critically EXCLUDES the two trivial wrong
answers 0 V (filter never charged) and 3.3 V (filter saw a constant high), as
well as any gross duty-cycle error (25 %→0.825 V or 75 %→2.475 V both fall
outside). The window is diagnostic of the duty-to-average physics, not padding.
