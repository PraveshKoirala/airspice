# LDO regulation — input well above dropout

## Circuit
```
vin(5V) --[U_REG: LDO Vtarget=3.3V, Vdropout=0.2V]-- vout
```

## Model under test (documented, not derived from the sim)
The AIR SPICE compiler (`air/spice.py::_ldo_line`) emits an LDO as a behavioural
controlled source:

    E_U_REG vout gnd VALUE = { min(3.3, V(vin) - 0.2) }

i.e. the regulated output is `Vout = min(Vtarget, Vin − Vdropout)`. This is the
oracle's LDO physics. This ground-truth case pins the "input high enough to
regulate" branch of that min().

## Hand derivation

    Vin − Vdropout = 5.0 V − 0.2 V = 4.800 V
    Vtarget        = 3.300 V

    Vout = min(Vtarget, Vin − Vdropout)
         = min(3.300 V, 4.800 V)
         = 3.300 V      (regulator is in regulation; the 3.3 V target wins)

## Expected value
**Vout = 3.300 V, exact** (the target rail).

## Tolerance
The behavioural source is exact; only solver tolerance applies. Window
**3.267 V – 3.333 V** (±1.0 %, ±33 mV) ≈10× ngspice `reltol`. This is the
regulation-window form the issue asks for; because the oracle's LDO is ideal
(no load regulation term), the physical window collapses to the target value and
the tolerance is purely numerical. A real datasheet LDO would specify e.g. ±2 %,
which would be a WIDER window — so this tight window is the strictly harder test.
