# Ground truth: ATmega328 + resistive divider on A0 ADC

## Circuit

A 5 V rail feeds a two-resistor divider whose tap (`a0_sense`) is read by the
ATmega328P ADC on the `A0` pin (Arduino Uno silkscreen name; datasheet ADC0 on
port PC0). The ATmega328P ADC uses the AVCC reference by default, so the model
carries `ADC1.vref = 5.0 V`.

```
 vcc (5 V) ── R_TOP 10k ──┬── a0_sense ── (A0 / ADC0)
                          │
                       R_BOTTOM 10k
                          │
                         gnd
```

## Hand-derived value (before any simulation)

Unloaded divider (the ADC pin is high-impedance, so no divider loading):

    V(a0_sense) = 5 V · R_BOTTOM / (R_TOP + R_BOTTOM)
                = 5 V · 10k / (10k + 10k)
                = 5 V · 0.5
                = 2.500 V   (exact rational ratio)

This is well under the 5.0 V ADC reference, so the ADC binding on A0 must NOT
trip `ADC_INPUT_EXCEEDS_VREF`. The oracle's one-node divider estimator
(`validation._estimate_net_voltage`) computes the same 2.500 V and confirms it
is below vref = 5.0 V.

Window `[2.475, 2.525] V` is ±0.5 % of 2.500 V, absorbing only ngspice's solver
reltol — the value itself is exact.

## What this proves (deliverable 1 of issue #105)

1. A design targeting `part="ATmega328P"` **validates** — the MCU part resolves
   in the registry, VCC/GND power/ground pins are present, and the `A0` pin with
   `function="ADC1_CH0"` is an accepted function for that pin.
2. The ADC binding (`peripheral=ADC1`, 5.0 V vref) passes the vref check for a
   2.5 V tap.
3. The design **emits + simulates**: the MCU emits nothing to SPICE (as designed
   for `type="mcu"`), the two resistors emit `R_*` cards, and ngspice solves the
   tap to 2.500 V.

## Provenance

- ATmega328P: Microchip ATmega328P datasheet (DS40002061B); Arduino Uno Rev3 pin
  mapping (A0-A5 = ADC0-ADC5 on PC0-PC5, 10-bit ADC, AVCC/AREF reference).
- Divider math: ideal voltage divider (Ohm's law); no part-specific SPICE model
  needed — plain resistors.
