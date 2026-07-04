# Inverting op-amp gain -Rf/Rin — EXPECTED FAILURE (oracle bug #55)

## Circuit and the physics we WOULD assert
```
vin(1V) --[R_IN=10k]--+-- inv (-)  \
                       |            [U_OA] --> vout
             [R_F=22k]-+             / (+) = gnd
                       |
                     vout
```
Textbook inverting amplifier. With an ideal op-amp the inverting input is a
virtual ground (V- = V+ = 0), so:

    I_in = Vin / R_IN  flows through R_F into the output:
    V_out = -I_in · R_F = -Vin · R_F / R_IN

**Hand derivation:**

    Gain = -R_F / R_IN = -22k / 10k = -2.20  (exact)
    V_out = Gain · Vin = -2.20 · 1.0 V = -2.200 V

Ground-truth check: `V(vout) = -2.200 V`, window ±5 % (resistor pair tolerance)
→ **[-2.31 V, -2.09 V]**. This is the check we WOULD assert.

## Why the oracle cannot produce it (bug #55 / missing primitive)
AIR has no op-amp primitive that the SPICE compiler can emit with a defined
model or subcircuit:
- `opamp` is not in `SUPPORTED_SPICE_TYPES`, and `_component_line` has no branch
  for it; without a subckt it emits nothing and logs `UNSUPPORTED_SPICE_COMPONENT`.
- Supplying `spice_subckt="OPAMP_IDEAL"` makes `_component_line` emit
  `X_U_OA gnd inv vout OPAMP_IDEAL`, but the compiler never emits a matching
  `.subckt OPAMP_IDEAL ...` definition.

Either way ngspice has no active device between `inv` and `vout`; with the subckt
name present it reports `unknown subckt: ... opamp_ideal`, exits non-zero, writes
no waveforms, and `simulator.py` downgrades to `builtin_dc_fallback` with a hollow
`passed` — oracle bug **#55**. The DC fallback has no op-amp model, so it cannot
produce -2.2 V.

## Disposition
**Expected failure**, linked to **#55** (and the underlying "no op-amp/VCVS
primitive" gap). The runner asserts the oracle returns no real ngspice result
(`backend != "ngspice"`). When an ideal op-amp (e.g. a VCVS-based subckt the
compiler defines) is added, the [-2.31, -2.09] V window becomes the acceptance
test.

## Tolerance (for when the primitive exists)
Ideal-op-amp gain is exact; the physical window is set by the two resistors'
tolerance. ±1 % resistors → gain error ≈ ±2 % → ±0.044 V; using a conservative
±5 % pair gives **[-2.31 V, -2.09 V]**. From resistor tolerance math, not
simulation.
