# Ground truth: NTC thermistor divider at 25 C

## Circuit

An NTC 10k thermistor (Vishay NTCLE100E3103, R25 = 10 kOhm, B25/85 = 3977 K) in
the top leg of a divider off a 5 V rail, with a fixed 10 kOhm lower leg. The
thermistor is modelled as a **parameterized resistor** whose `<value>` is its
resistance at the temperature under test.

```
 vcc (5 V) ── R_THERM (NTC, 10k @ 25C) ──┬── therm_sense
                                         │
                                    R_FIXED 10k
                                         │
                                        gnd
```

## Hand-derived value (before any simulation)

The defining property of R25 is that the NTC's resistance at 25 C **is** its
rated value, exactly: R(25 C) = R25 = 10 kOhm (R/R25 = 1.000 by definition, no
Beta approximation involved). So the tap is an exact rational ratio:

    V(therm_sense) = 5 V · R_FIXED / (R_THERM + R_FIXED)
                   = 5 V · 10k / (10k + 10k)
                   = 5 V · 0.5
                   = 2.500 V   (exact)

Window `[2.475, 2.525] V` is ±0.5 % of 2.500 V, absorbing only ngspice's solver
reltol.

## Resistance-vs-temperature (the sensor behavior)

Away from 25 C the resistance follows the Beta (B-parameter) law:

    R(T) = R25 · exp( B · (1/T − 1/T25) ),  T,T25 in kelvin, T25 = 298.15 K

Worked points (used by the sibling `thermistor_divider_hot` circuit and the
registry entry): R(0 C) ≈ 33.9 kOhm, R(25 C) = 10.0 kOhm, R(50 C) ≈ 3.563 kOhm.
As temperature rises the NTC resistance falls, so a top-leg NTC raises the tap
with temperature. **The Beta equation is an approximation** valid within its
25-85 C fitting window; the datasheet R/R25 table is the exact reference and the
Beta result diverges a few percent far from 25 C. That is why the *asserted*
micro-verification point is the exact 25 C value, and the 50 C point carries a
wider tolerance window (see `thermistor_divider_hot`).

## Honesty note

This is a **behavioral parameterized-resistor** stand-in, not a datasheet-exact
thermal SPICE model. There is no self-heating, no thermal time constant, and no
temperature port: the temperature is chosen by the spec author as the resistor
`<value>` at that temperature. The emitter produces a plain `R` card; the divider
math is what the spec asserts.

## Provenance

Vishay NTCLE100E3103 datasheet (doc 29049): R25 = 10 kOhm ±5 %, B25/85 = 3977 K
±0.75 %, range −40..125 C. https://www.vishay.com/docs/29049/ntcle100.pdf
