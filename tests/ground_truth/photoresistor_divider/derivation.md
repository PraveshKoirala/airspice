# Ground truth: LDR (photoresistor) divider at 10 lux

## Circuit

A GL5528 CdS photoresistor in the top leg of a divider off a 5 V rail, with a
fixed 10 kOhm lower leg. The LDR is modelled as a **parameterized resistor**
whose `<value>` is its resistance at the illuminance under test.

```
 vcc (5 V) ── R_LDR (GL5528, 10k @ 10 lux) ──┬── ldr_sense
                                             │
                                        R_FIXED 10k
                                             │
                                            gnd
```

## Hand-derived value (before any simulation)

At the datasheet **10 lux typical**, R_LDR ≈ 10 kOhm (GL5528 10 lux range is
8-20 kOhm, typical 10 kOhm), so:

    V(ldr_sense) = 5 V · R_FIXED / (R_LDR + R_FIXED)
                 = 5 V · 10k / (10k + 10k)
                 = 2.500 V

Unlike an NTC's R25 (exact by definition), a CdS cell is specified as a
**resistance range** at 10 lux, so the ±5 % window `[2.375, 2.525→2.625] V`
reflects that the "10 kOhm" is a typical, not an exact, value. The tap still
tracks the typical build point.

## Resistance-vs-light (the sensor behavior)

    R(E) = R_10lux · (E / 10 lux)^(−gamma),  gamma ≈ 0.7  (log-log slope, 10..100 lux)

Worked points: dark (0 lux) R ≥ 1 MOhm, 10 lux ≈ 10 kOhm, 100 lux ≈ 2 kOhm. More
light ⇒ lower resistance ⇒ (top-leg LDR) lower tap. In the dark the top leg is
~1 MOhm, collapsing the tap to ≈ 5 V · 10k/1.01M ≈ 0.0495 V — proven by the
sibling `photoresistor_divider_dark` circuit.

## Honesty note

Behavioral parameterized-resistor stand-in, not a datasheet optical SPICE model.
No light port, no spectral model: illuminance is chosen by the spec author as the
resistor `<value>` at that illuminance. The emitter produces a plain `R` card;
the divider math is what the spec asserts.

## Provenance

Senba/Shenzhen GL5528 CdS photoresistor datasheet (GL55 series): 10 lux
resistance 8-20 kOhm, dark resistance ≥ 1 MOhm, gamma100 ≈ 0.7, peak 540 nm.
https://www.handsontec.com/dataspecs/sensor/GL55-LDR.pdf
