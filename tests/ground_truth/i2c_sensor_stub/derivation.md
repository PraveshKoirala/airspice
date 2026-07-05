# Ground truth: behavioral I2C sensor stub (electrical-only)

## Circuit

An ATmega328P I2C controller on a 5 V rail talks to an **abstracted** I2C sensor.
Only the sensor's electrical envelope is modelled:

- two 4.7 kOhm pull-ups, SDA->rail and SCL->rail (open-drain I2C requires them);
- a 1 mA `generic_load` between the rail and ground = the sensor's active supply
  draw.

```
 vcc (5 V) ──┬── R_PU_SDA 4.7k ── i2c_sda ── (A4 / SDA)
             ├── R_PU_SCL 4.7k ── i2c_scl ── (A5 / SCL)
             └── I_U_SENSOR 1 mA ── gnd        (sensor supply draw)
```

## Hand-derived value (before any simulation)

The bus is **idle** (no device is driving SDA or SCL low). Each line connects to
the rail only through its pull-up, and no current flows through a pull-up whose
far end is open, so:

    V(i2c_sda) = V(rail) = 5.000 V
    V(i2c_scl) = V(rail) = 5.000 V

This is the defining electrical property of an idle open-drain I2C bus: the
pull-ups hold both lines high. Window `[4.95, 5.05] V` is ±1 % of 5 V, absorbing
solver reltol only.

The 1 mA supply `generic_load` draws from the rail (it appears in the rail load
budget) but does not affect the SDA/SCL line voltages, since those lines have no
DC path to ground other than through their pull-ups.

## What this proves (deliverable 2, I2C sensor stub, of issue #105)

1. The electrical-only I2C sensor envelope **validates**: the `<interface
   type="i2c">` declares both pull-ups to the power rail (no
   `I2C_PULLUPS_NOT_DECLARED` / `I2C_PULLUP_NOT_POWER_RAIL`), the ATmega328 A4/A5
   pins accept `I2C_SDA`/`I2C_SCL`, and the pull-up values (4.7 k) are in the
   healthy range (no too-weak/too-strong warning).
2. It **emits + simulates**: the pull-ups emit `R` cards, the sensor supply draw
   emits `I_U_SENSOR ... DC 1mA`, the MCU emits nothing, and ngspice holds the
   idle bus at the 5 V rail.

## Honesty note

This is an **electrical-only** stub. It models the sensor's footprint on the bus
(supply current + open-drain pull-up topology) and nothing else — no register map,
no protocol, no measured data value. The sensor's "reading" is out of analog scope
and belongs to executable firmware (epic M8). Use it in a build spec tagged
`abstracted` to test that the agent wires an I2C device correctly, not that it
models the sensor's physics.

## Provenance

- I2C-bus specification UM10204 (open-drain SDA/SCL, 2.2 k-10 k pull-ups).
- Representative small-sensor active supply current 0.1-2 mA (e.g. Bosch BME280
  datasheet lists ~0.7 mA active). See `registry/imported/i2c_sensor_stub.json`.
- ATmega328P I2C on A4 (SDA) / A5 (SCL): Microchip ATmega328P datasheet + Arduino
  Uno pin mapping.
