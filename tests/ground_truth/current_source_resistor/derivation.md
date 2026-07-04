# Current source into resistor — Ohm's law

## Circuit
```
  (I_SRC = 2 mA) ==> vnode --[R_L = 2.2k]-- gnd
```
An ideal 2 mA current source forces its current through `R_L` to ground. By
Ohm's law the node voltage is `I · R`.

## SPICE current-source direction (verified separately, documented here)
The AIR compiler emits `current_source` as `I_<id> <pin0> <pin1> DC <value>`
(first-declared pin = SPICE n+, second = n-). The SPICE/ngspice convention is
that a positive source value drives conventional current from n+ to n- *inside*
the source, i.e. it *injects* `value` amps **into the second node (n-)**.

Bench check (pure resistor, no unknowns): `I1 0 n1 DC 1m` with `R1 n1 0 1k`
gives `v(n1) = +1.000 V` — confirming current is pushed into the second node.
Therefore this design declares `pin p = gnd` (n+) and `pin n = vnode` (n-) so the
2 mA is injected into `vnode` and returns through `R_L`, producing a **positive**
node voltage.

## Hand derivation

    V(vnode) = I · R
             = 2e-3 A · 2200 Ω
             = 4.400 V

(Exactly 2 mA × 2.2 kΩ = 4.4 V.)

## Expected value
**V(vnode) = 4.400 V, exact.**

## Tolerance
Ideal source and ideal resistor; only solver numerical tolerance applies. Window
**4.356 V – 4.444 V** (±1.0 %, ±44 mV) ≈10× ngspice `reltol`, no physical slack.
