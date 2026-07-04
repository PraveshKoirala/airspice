# Loaded divider — Thevenin equivalent

## Circuit
```
vin --[R1 = 10k]-- vout --[R2 = 10k]-- gnd
                    |
                  [R_LOAD = 10k]
                    |
                   gnd
```
`V_IN = 12 V`. The tap `vout` now feeds a load `R_LOAD = 10 kΩ` to ground in
parallel with `R2`. The naive (unloaded) divider ratio no longer applies; we use
the Thevenin equivalent seen by the load.

## Hand derivation (Thevenin)
**Step 1 — open-circuit (Thevenin) voltage at `vout` with the load removed:**

    V_th = V_IN · R2 / (R1 + R2)
         = 12 V · 10k / (10k + 10k)
         = 12 · (1/2)
         = 6.000 V

**Step 2 — Thevenin resistance (source shorted, looking into `vout`):**
R1 and R2 appear in parallel to ground.

    R_th = R1 ∥ R2 = (10k · 10k) / (10k + 10k)
         = 100e6 / 20000
         = 5.000 kΩ

**Step 3 — reattach the load and divide:**

    V_out = V_th · R_LOAD / (R_th + R_LOAD)
          = 6.000 V · 10k / (5k + 10k)
          = 6 · 10/15
          = 6 · (2/3)
          = 4.000 V

**Independent cross-check (collapse R2 ∥ R_LOAD first):**

    R2 ∥ R_LOAD = 10k ∥ 10k = 5.000 kΩ
    V_out = V_IN · (R2∥R_LOAD) / (R1 + R2∥R_LOAD)
          = 12 · 5k / (10k + 5k)
          = 12 · 5/15
          = 4.000 V   ✓ (agrees with the Thevenin result)

## Expected value
**V_out = 4.000 V, exact.**

> Bounds below are from the two independent hand calculations above, not from a
> simulator.

## Tolerance
All-ideal linear network; the only error is solver numerical tolerance. Window
**3.960 V – 4.040 V** (±1.0 %, ±40 mV) is ≈10× ngspice `reltol`, no physical
slack.
