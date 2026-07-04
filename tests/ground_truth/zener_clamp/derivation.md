# Zener clamp voltage — EXPECTED FAILURE (oracle bug #55)

## Circuit and the physics we WOULD assert
```
vin(12V) --[R_S = 1k]-- clamp --[D_Z reverse]-- gnd
```
`D_Z` is a 5.1 V Zener oriented so its cathode is on `clamp` and anode on gnd —
i.e. it is reverse-biased by the positive rail and operates in breakdown.

**Hand derivation (if the Zener were modelled):**
The Zener holds its cathode near the breakdown voltage BV = 5.1 V. The series
resistor drops the rest:

    V(clamp) ≈ V_Z = 5.1 V
    I_Z = (Vin − V_Z) / R_S = (12 − 5.1) / 1000 = 6.9 mA   (a sane Zener current)

Accounting for the finite Zener impedance (Zzt ≈ 5–15 Ω near IZT), the clamp sits
a few tens of mV above BV:

    V(clamp) ≈ 5.1 + 6.9mA · ~10Ω ≈ 5.17 V

Ground-truth window: **V(clamp) ∈ [4.9, 5.3] V** (datasheet BV tolerance ±5 %
plus the Zzt·Iz term). This is the check we WOULD assert.

## Why the oracle cannot produce it (bug #55)
Reverse breakdown needs a diode model with a `BV` parameter. The generic
`.model D D` has BV = ∞ (no breakdown), so with the default model the "Zener"
would just look like an open circuit and `clamp` would rise to nearly 12 V —
wrong. To get real Zener behaviour the design sets `spice_model="ZENER_5V1"`. The
compiler emits:

    D_D_Z 0 clamp ZENER_5V1

with no matching `.model ZENER_5V1 D(BV=5.1 ...)` card. Real ngspice reports
`can't find model 'zener_5v1'`, exits non-zero, writes no waveforms; the
simulator downgrades to `builtin_dc_fallback` and reports a hollow `passed` —
oracle bug **#55**.

## Disposition
**Expected failure**, linked to **#55**. The runner asserts the oracle returns no
real ngspice result (`backend != "ngspice"`). When #55 is fixed so a Zener model
reaches the netlist, the [4.9, 5.3] V window becomes the acceptance test.

## Tolerance (for when #55 is fixed)
Datasheet BV tolerance (±5 % on a 5.1 V part → ±0.26 V) plus the Zzt·Iz rise →
**4.9 V – 5.3 V**, from datasheet numbers, not simulation.
