# Resistive divider — exact ratio

## Circuit
Ideal DC voltage source `V_IN = 9 V` drives a two-resistor series string to
ground:

```
vin --[R_TOP = 20k]-- vout --[R_BOTTOM = 10k]-- gnd
```

`vout` is the divider tap. It is unloaded (no current leaves the `vout` node
except through `R_BOTTOM`), so the ideal voltage-divider relation holds exactly.

## Hand derivation
Single-loop series current:

    I = V_IN / (R_TOP + R_BOTTOM)
      = 9 V / (20 kΩ + 10 kΩ)
      = 9 / 30000 A
      = 3.0e-4 A  (0.30 mA)

The tap voltage `vout` referenced to ground is the drop across the bottom leg:

    V_out = I · R_BOTTOM
          = 3.0e-4 A · 10000 Ω
          = 3.000 V

Equivalently, by the divider ratio:

    V_out = V_IN · R_BOTTOM / (R_TOP + R_BOTTOM)
          = 9 V · 10 kΩ / 30 kΩ
          = 9 · (1/3)
          = 3.000 V   (exact rational)

## Expected value
**V_out = 3.000 V, exact** (rational 9 × 1/3).

> The `<assert_voltage>` window in the XML and the `expected.json` bounds are
> written against this hand-derived 3.000 V, computed above with a calculator —
> not copied from any simulator run.

## Tolerance
Ideal source, ideal linear resistors, no load — the only error source is the
solver's numerical convergence tolerance (ngspice `reltol` default ≈ 1e-3, i.e.
~3 mV on a 3 V node). The chosen window **2.970 V – 3.030 V** (±1.0 %, ±30 mV)
is ≈10× the solver tolerance and carries no physical slack: it exists only to
absorb floating-point/solver noise. No component-tolerance term is included
because the netlist uses ideal nominal values (a real ±1 % resistor pair would
widen this to ≈ ±0.7 % on the ratio, still inside the window).
