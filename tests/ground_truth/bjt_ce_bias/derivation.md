# BJT common-emitter bias point — generic NPN (Bf = 100)

## Circuit
```
       vcc (5V)
        |
      [R_C = 1k]
        |
     collector ------ Q1.C
                       Q1.B ---- base <== (I_B = 10 uA forced)
                       Q1.E ---- gnd
```
Base current is FORCED by an ideal 10 uA current source, so the collector current
follows directly from the current gain and does not depend on the (uncertain)
base–emitter voltage. This deliberately removes Vbe from the answer, making the
bias point exactly hand-derivable.

## Model under test (documented from the compiler source)
`air/spice.py` emits every NPN with the header card `.model NPN NPN(Bf=100)`.
The only non-default parameter is the forward current gain `Bf = 100`. All other
Gummel–Poon parameters take ngspice defaults; notably the forward Early voltage
`VAF` defaults to infinity (no output-conductance correction) and the
low-current recombination term `Ise` defaults to 0, so the effective forward
beta is constant `βF = Bf = 100` across the moderate current used here.

## SPICE current-source direction (documented)
`current_source` emits `I_<id> <pin0> <pin1> DC <value>`; a positive value injects
`value` amps into the SECOND pin (verified with a resistor test — see
`current_source_resistor/derivation.md`). Here `pin p = gnd`, `pin n = base`, so
10 uA is injected INTO the base node — the correct direction to forward-bias an
NPN base.

## Hand derivation
**Collector current** (forward-active region):

    I_C = βF · I_B
        = 100 · 10 uA
        = 1.000 mA

**Collector node voltage** (drop across R_C from the 5 V rail):

    V_C = V_CC − I_C · R_C
        = 5.0 V − (1.0e-3 A · 1000 Ω)
        = 5.0 − 1.0
        = 4.000 V

**Active-region validity check** (must hold for I_C = βF·I_B to be valid):

    V_CE = V_C − V_E = 4.000 V − 0 V = 4.000 V

Since `V_CE = 4.0 V >> V_CE(sat) ≈ 0.2 V`, the transistor is comfortably in the
forward-active region, so `I_C = βF·I_B` applies and the derivation is
self-consistent. (If the device had saturated, V_C would clamp near 0.2 V and the
window below would catch it.)

## Expected value
**V_C = 4.000 V.**

## Tolerance
The dominant uncertainty is the effective beta. With the default Gummel–Poon
model, βF equals Bf almost exactly at 1 mA, but small base-width / high-level
injection terms can shave a few percent:

- A ±10 % beta error → I_C ∈ [0.9, 1.1] mA → V_C ∈ [5 − 1.1, 5 − 0.9] = [3.9, 4.1] V.
- Widening slightly for solver tolerance and model-build differences between
  ngspice 42/46 gives the window **3.80 V – 4.20 V** (I_C ∈ [0.8, 1.2] mA,
  β_eff ∈ [80, 120]).

This window is diagnostic: a saturated transistor (V_C ≈ 0.2 V) or a dead one
(V_C ≈ 5 V) both fall well outside it, and it corresponds to a physically
sensible ±20 % spread on the current gain.
