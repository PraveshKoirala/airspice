# Silicon diode forward drop — generic D model, Shockley equation

## Circuit
```
  (I_FWD = 1 mA) ==> anode --[D1]-- gnd
```
A 1 mA current source forces forward current through diode `D1`. The forward
voltage is read at `anode`.

## Model under test (documented from the compiler source, not the sim)
`air/spice.py` emits every diode with the header line `.model D D` and no custom
parameters. ngspice's built-in diode defaults are therefore in force:

    IS  (saturation current) = 1.0e-14 A   (ngspice default)
    N   (emission coefficient) = 1.0        (ngspice default)
    RS  (series resistance) = 0
    Temperature = 27 °C = 300.15 K          (ngspice default TEMP)

## Hand derivation (Shockley diode equation)
For forward current `I` well above `IS`, the diode equation
`I = IS·(exp(V/(N·Vt)) − 1)` inverts to:

    V_f = N · Vt · ln(I / IS + 1)

Thermal voltage at 27 °C:

    Vt = kT/q
       = (1.380649e-23 J/K · 300.15 K) / 1.602176634e-19 C
       = 4.144117e-21 / 1.602176634e-19
       = 0.0258640 V   (25.864 mV)

Argument:

    I / IS = 1.0e-3 / 1.0e-14 = 1.0e11
    ln(1.0e11 + 1) ≈ ln(1.0e11) = 11 · ln(10) = 11 · 2.3025851 = 25.32844

Forward voltage:

    V_f = 1 · 0.0258640 V · 25.32844
        = 0.655095 V
        ≈ 0.655 V

## Expected value
**V_f ≈ 0.655 V** (generic silicon diode at 1 mA, 27 °C).

## Tolerance
The value is model-parameter sensitive, so the window is physics-justified, not
numerical:

- **Saturation-current spread.** V_f moves by `Vt·ln(2) = 17.9 mV` for every 2×
  change in IS. Allowing the effective IS to differ by a few× from the nominal
  1e-14 (ngspice build/temperature-model details) gives roughly ±30 mV.
- **Temperature.** IS is strongly temperature dependent; ±5 °C shifts V_f by a
  few mV. The 27 °C default is fixed here, but the window tolerates minor
  temperature-model differences between ngspice builds.
- **Slope.** At 1 mA the small-signal resistance is `Vt/I = 25.9 Ω`, so a ±10 %
  error in the forced current moves V_f by only `25.9·0.1mA ≈ 2.6 mV` —
  negligible.

Chosen window: **0.600 V – 0.710 V** (nominal 0.655 V, roughly −55 mV/+55 mV).
This brackets the generic-silicon forward drop and, importantly, EXCLUDES both a
typical red-LED drop (~1.8–2.0 V) and a Schottky drop (~0.3 V) — so a wrong diode
model would be caught.

## Note on the requested "LED forward-drop by color" case
A color-specific LED (Vf ≈ 2.0 V red, ≈ 3.1 V blue) cannot be produced by the
generic `.model D D`. It needs a per-part model (`spice_model="LED_RED"` etc.),
which the compiler emits as an undefined model name — the exact failure mode of
oracle bug #55. That variant is captured as an expected-failure in
`tests/ground_truth/led_forward_drop/`.
