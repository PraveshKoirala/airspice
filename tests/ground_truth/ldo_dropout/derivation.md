# LDO in dropout

## Circuit
```
vin(3.4V) --[U_REG: LDO Vtarget=3.3V, Vdropout=0.2V]-- vout
```
Same LDO model as `ldo_regulation_inrange`, but the input is deliberately only
0.1 V above the target — below the headroom the regulator needs.

## Model under test
`air/spice.py::_ldo_line` emits:

    E_U_REG vout gnd VALUE = { min(3.3, V(vin) - 0.2) }

So `Vout = min(Vtarget, Vin − Vdropout)`.

## Hand derivation

    Vin − Vdropout = 3.4 V − 0.2 V = 3.200 V
    Vtarget        = 3.300 V

    Vout = min(3.300 V, 3.200 V)
         = 3.200 V     (dropout branch wins: the regulator can no longer reach
                        its target and tracks Vin − Vdropout)

## Expected value
**Vout = 3.200 V, exact.**

This case is chosen specifically so the OTHER argument of the `min()` wins,
proving the runner is exercising real regulator behaviour and not just reading
back the `vout` property (which is 3.3 V). If the oracle returned 3.3 V here it
would be a bug — captured by the tolerance window excluding 3.3 V.

## Tolerance
Behavioural source is exact; solver tolerance only. Window **3.168 V – 3.232 V**
(±1.0 %, ±32 mV). Note the upper bound 3.232 V < 3.3 V, so a regulator that
failed to drop out (returned the 3.3 V target) would FAIL this test — the window
is diagnostic, not merely numerical padding.
