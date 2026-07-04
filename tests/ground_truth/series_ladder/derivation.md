# Three-resistor series ladder — two tap voltages

## Circuit
```
vin --[R1=1k]-- tap_a --[R2=2k]-- tap_b --[R3=2k]-- gnd
```
`V_IN = 10 V`. Single series loop (no branches), so one current flows through all
three resistors.

## Hand derivation
Total resistance:

    R_total = R1 + R2 + R3 = 1k + 2k + 2k = 5.000 kΩ

Series current:

    I = V_IN / R_total = 10 V / 5000 Ω = 2.000 mA

Tap voltages measured to ground are the accumulated drop across everything BELOW
the tap:

**tap_a** (above R2+R3):

    V(tap_a) = I · (R2 + R3) = 2e-3 · (2000 + 2000) = 2e-3 · 4000 = 8.000 V

    cross-check: V_IN − I·R1 = 10 − 2e-3·1000 = 10 − 2 = 8.000 V ✓

**tap_b** (above R3):

    V(tap_b) = I · R3 = 2e-3 · 2000 = 4.000 V

## Expected values
- **V(tap_a) = 8.000 V, exact**
- **V(tap_b) = 4.000 V, exact**

## Tolerance
Ideal linear network; solver tolerance only. Windows ±1.0 %:
- tap_a: **7.920 V – 8.080 V**
- tap_b: **3.960 V – 4.040 V**
Both ≈10× ngspice `reltol`, no physical slack.
