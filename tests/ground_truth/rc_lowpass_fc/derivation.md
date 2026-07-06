# RC low-pass attenuation at fc (verified via `.ac`, issue #62)

## Circuit
```
vin --[R_F = 1.6k]-- vout --[C_F = 100nF]-- gnd
```
The `V_IN` source is DC-biased at 1 V AND carries `ac_magnitude=1V`, so under
the `.ac` sweep it injects a unit small-signal stimulus at every frequency in
the sweep. The oracle emits (real ngspice v46 batch mode):

```
V_V_IN vin 0 DC 1 AC 1
R_R_F vin vout 1.6k
C_C_F vout 0 100n
.ac dec 40 10 1e+06
wrdata ../waveforms/lpf_fc_vout.csv vdb(vout) vp(vout)
```

## Physics we now verify
First-order RC low-pass. Corner (-3 dB) frequency:

    fc = 1 / (2*pi * R * C)
       = 1 / (2*pi * 1600 * 100e-9)
       = 1 / (1.005310e-3)
       = 994.72 Hz    (~= 995 Hz)

At the corner the first-order transfer magnitude is exactly `1/sqrt(2)`:

    |H(fc)| = 1 / sqrt(1 + (f/fc)^2) = 1/sqrt(2) = 0.707107
    in dB : 20*log10(0.707107) = -3.0103 dB
    phase : -atan(f/fc) = -atan(1) = -45.00 deg

With `ac_magnitude=1V` the oracle's `vdb(vout)` at f=fc is `-3.01 dB`. The
ground-truth assertion `assert_gain_db_at_freq net=vout freq=994.72Hz min_db=-3.15
max_db=-2.87` compares the closest-in-log-frequency sample point against this
window.

Complementary sanity checks recorded in `expected.json`:

* **Passband (100 Hz, ~10x below fc):** first-order `|H| = 1/sqrt(1 + 0.01) =
  -0.043 dB`, so the sample must land in `[-0.5, 0.1] dB`. Confirms the DC gain
  is unity (there is no attenuator drift).
* **Stopband (10 kHz, ~10x above fc):** first-order rolloff gives `|H| = 1/sqrt(1
  + 100) = -20.04 dB`; the nearest log-sample at 10 kHz is `-20.13 dB`. Confirms
  the 20 dB/decade rolloff slope.

Together the three points pin the corner AND the rolloff slope AND the DC gain,
which is the classic filter check the ground-truth suite was blocked from
running before this issue was implemented.

## Tolerance
Component tolerance +-1% on R and +-1% on C -> +-1.4% on fc. Near the corner
`d|H|/|H| ~= (f/fc)^2 / (1 + (f/fc)^2)` * (dfc/fc), so the +-1.4% fc shift moves
|H| at the fixed 994.72 Hz assertion by at most ~0.14 dB. Window
`[-3.15, -2.87] dB` covers both tolerance and the log-nearest-sample slip on the
40-points-per-decade sweep.

## Historical note (issue #62 root cause, now closed)
Before this issue was implemented, `air/spice.py::compile_spice` only emitted
`.tran <duration>` with DC sources and no `.ac` card. A DC source driving an RC
low-pass just charges the cap to the DC input and the transient settles to `Vout
= Vin = 1 V` (0 dB at DC), so the frequency-domain answer was unreachable
through the oracle. `rc_lowpass_fc` was captured as an expected-failure linked to
this issue; the assertion window it wanted (`[0.697, 0.717] V`, the 0.7071 V
-3 dB target on a linear scale) is now the AC dB window
`[-3.15, -2.87] dB` here.
