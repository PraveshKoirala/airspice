# RC low-pass attenuation at fc — EXPECTED FAILURE (compiler emits no AC analysis)

## Circuit and the physics we WOULD assert
```
vin --[R_F = 1.6k]-- vout --[C_F = 100nF]-- gnd
```
First-order RC low-pass. Corner (−3 dB) frequency:

    fc = 1 / (2·pi·R·C)
       = 1 / (2·pi · 1600 Ω · 100e-9 F)
       = 1 / (2·pi · 1.600e-4)
       = 1 / (1.005310e-3)
       = 994.72 Hz   (≈ 995 Hz)

At the corner frequency the magnitude transfer of a first-order low-pass is, by
definition, `1/√2`:

    |H(fc)| = 1 / sqrt(1 + (f/fc)^2) = 1 / sqrt(1 + 1) = 1/sqrt(2) = 0.707107
    in dB : 20·log10(0.707107) = -3.0103 dB
    phase : -atan(f/fc) = -atan(1) = -45.00 deg

For a 1 V-amplitude input at fc, the output amplitude is **0.7071 V** (−3.01 dB).
Ground-truth check we WOULD assert: `|Vout(fc)| = 0.7071 V`, window
**[0.697, 0.717] V** (±1.4 %, from the R·C corner tolerance below).

## Why the oracle cannot produce it (compiler limitation, NOT #55)
The magnitude at a specific frequency is a **frequency-domain** quantity; it
requires an AC small-signal sweep (`.ac`) with an AC-tagged source. But
`air/spice.py::compile_spice` only ever emits:

    .tran 1u <duration>

with the stimulus as a constant `DC` source (`V_VIN vin 0 DC 1V`). There is no
`.ac` card and no `AC 1` magnitude on any source. A DC source through an RC low
pass simply charges the cap to the DC input and sits there — the transient
settles to `Vout = Vin = 1 V` (0 dB at DC), which tells us nothing about the −3 dB
point. The oracle has **no path** to a frequency response, so the fc attenuation
is unverifiable through it.

This is distinct from bug #55 (undefined models). Here every component IS
emittable and ngspice DOES run — it just runs the wrong analysis (DC transient
instead of an AC sweep) for the question being asked.

## Disposition
**Expected failure** due to a missing-analysis gap in the compiler. A NEW
oracle-gap issue is filed ("SPICE compiler emits no .ac analysis, so
frequency-domain checks (RC low-pass −3 dB at fc, filter rolloff) are
unverifiable"). The runner records this as an expected-failure referencing that
issue. When `.ac` support lands, the [0.697, 0.717] V window becomes the
acceptance test.

Note on the runner's mechanical check: because ngspice DOES run this netlist
(all components emittable), the report will carry `backend: ngspice` with
`Vout ≈ 1 V` (the DC settle), which is NOT the −3 dB answer. The runner therefore
verifies this circuit by confirming the transient DC-settles to ≈Vin (≈1 V) and
does NOT land in the −3 dB window — proving the frequency-domain check is absent —
rather than by the `backend != ngspice` test used for the #55 cases.

## Tolerance (for when .ac exists)
The corner frequency shifts with R·C tolerance; ±1 % R and ±1 % C → ±1.4 % on fc,
which near the corner moves |H| by well under 1 %. Window **[0.697, 0.717] V**
(±1.4 % about 0.7071 V) from component-tolerance math, not simulation.
