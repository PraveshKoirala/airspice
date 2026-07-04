# LED forward-drop window by color — EXPECTED FAILURE (oracle bug #55)

## What the physics says (ground truth we WOULD assert)
A standard red LED conducting 10 mA has a datasheet forward voltage in the
window **Vf ≈ 1.8 – 2.2 V** (e.g. Kingbright WP7113SRD, Vishay TLHR: typical
1.8–2.0 V at 10 mA; the band by color runs red ~1.8–2.2 V, green ~2.0–2.4 V,
blue/white ~2.8–3.4 V). The correct ground-truth check for this circuit is
therefore `V(anode) ∈ [1.8, 2.2] V`.

## Why the oracle cannot produce it (bug #55)
To get an LED-like 2 V drop (instead of the ~0.65 V of a generic silicon diode),
the diode needs an LED-specific model. This design sets `spice_model="LED_RED"`.
The compiler (`air/spice.py::_component_line`) emits:

    D_D_LED anode 0 LED_RED

but the netlist header only defines the generic `.model D D` — it never emits a
`.model LED_RED ...` card. Real ngspice then cannot resolve `LED_RED`:

    warning, can't find model 'led_red' ...
    Error: ... no simulations run!

ngspice exits non-zero and writes no waveforms, so `simulator.py` sets
`used_ngspice = False` and reports `"backend": "builtin_dc_fallback"` with
`"status": "passed"` — the exact silent-downgrade defect documented in **issue
#55**. The DC fallback does not model diodes at all, so any "value" it reports is
meaningless as ground truth.

## Disposition
This is an **expected failure** linked to oracle bug **#55**, not a new issue.
The runner asserts that the oracle does NOT return a real ngspice result here
(`backend != "ngspice"`); if some future fix makes ngspice actually simulate an
LED model, this case flips to a real pass and its window (1.8–2.2 V) becomes the
acceptance test. No expectation is tuned to the fallback's output.

## Tolerance (for when #55 is fixed)
Datasheet min/max by color; red at 10 mA → **1.8 V – 2.2 V** (±0.2 V about the
~2.0 V typical), sourced from LED datasheets, not simulation.
