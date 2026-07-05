# Ground truth: NTC thermistor divider at 50 C (R-vs-T shift)

Same divider as `thermistor_divider` (NTC 10k top leg, fixed 10k bottom leg,
5 V rail), but the NTC `<value>` is now its resistance at **50 C**, to exercise
the resistance-vs-temperature behavior of the sensor.

## Beta model

    R(T) = R25 · exp( B · (1/T − 1/T25) ),  T25 = 298.15 K, B = 3977 K, R25 = 10 kOhm

At T = 50 C = 323.15 K:

    R(50 C) = 10k · exp( 3977 · (1/323.15 − 1/298.15) )
            = 10k · exp( 3977 · (−2.594e-4) )
            ≈ 10k · 0.3563
            ≈ 3.563 kOhm

## Tap

    V(therm_sense) = 5 V · R_FIXED / (R_THERM + R_FIXED)
                   = 5 V · 10k / (3.563k + 10k)
                   = 3.686 V

Compared to 2.500 V at 25 C, the tap **rose** as the NTC resistance fell — the
negative-temperature-coefficient behavior of a top-leg thermistor.

## Tolerance rationale

The Beta equation is an approximation valid within its 25-85 C fitting window; the
Vishay R/R25 table (the exact reference) gives R(50 C) ≈ 3.60 kOhm, i.e. a tap of
≈ 3.676 V — about 0.3 % below the Beta result. The window `[3.61, 3.76] V` (±2 %
of 3.686 V) honestly absorbs this documented Beta-vs-datasheet divergence plus
solver reltol, while still being far from the 2.500 V (25 C) value, so the test
genuinely proves the temperature-driven shift.

## Honesty note

Behavioral parameterized-resistor stand-in (see `thermistor_divider/derivation.md`
and `registry/imported/ntc_10k_3977.json`). Temperature is chosen by the spec
author as the resistor `<value>`; there is no thermal SPICE model.

## Provenance

Vishay NTCLE100E3103 datasheet (doc 29049), B25/85 = 3977 K.
https://www.vishay.com/docs/29049/ntcle100.pdf
