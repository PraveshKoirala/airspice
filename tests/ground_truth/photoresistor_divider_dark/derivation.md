# Ground truth: LDR (photoresistor) divider in the dark

Same divider as `photoresistor_divider` (GL5528 top leg, fixed 10k bottom leg,
5 V rail), but the LDR `<value>` is now its **dark resistance** (1 MOhm, the
datasheet minimum), to exercise the light-vs-dark behavior of the sensor.

## Hand-derived value (before any simulation)

    V(ldr_sense) = 5 V · R_FIXED / (R_LDR + R_FIXED)
                 = 5 V · 10k / (1M + 10k)
                 = 5 V · 10k / 1.01M
                 = 0.0495 V

Compared to 2.500 V at 10 lux, the tap **collapsed** as the top-leg resistance
rose ~100x — the light-dependent behavior of a top-leg photoresistor: more light
⇒ lower R ⇒ higher tap; darkness ⇒ ~1 MOhm ⇒ tap near ground.

## Tolerance rationale

The datasheet gives dark resistance as "≥ 1 MOhm", so a real cell reads at or
below 0.0495 V. The window `[0.045, 0.055] V` (±10 % of 0.0495 V) absorbs that
floor plus solver reltol while staying two orders of magnitude away from the
10 lux value, so the test genuinely proves the illuminance-driven collapse.

## Honesty note

Behavioral parameterized-resistor stand-in (see
`photoresistor_divider/derivation.md` and `registry/imported/ldr_gl5528.json`).
Illuminance is chosen by the spec author as the resistor `<value>`; there is no
optical SPICE model.

## Provenance

GL5528 CdS photoresistor datasheet (GL55 series): dark resistance ≥ 1 MOhm.
https://www.handsontec.com/dataspecs/sensor/GL55-LDR.pdf
