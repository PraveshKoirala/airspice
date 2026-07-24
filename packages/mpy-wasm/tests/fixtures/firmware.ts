/**
 * Real MicroPython firmware fixtures (issue #37) — plain Python source strings
 * executed by the WASM runtime under test. These are TEST FIXTURES only.
 *
 * They are deliberately Arduino/MicroPython-idiomatic: a module-scope hardware
 * setup, a `setup()` run once at init, and a `loop()` called once per virtual
 * tick. The runtime installs a JS-backed `machine` module (Pin / ADC / virtual
 * time), so `import machine` resolves to those bridges — see support/runtime.ts.
 *
 * CRITICAL for the anti-stub guarantee: every observable output below is
 * COMPUTED by the Python interpreter from the injected inputs (an ADC read, a
 * ticks_ms() read). A stub runtime returning canned GPIO cannot reproduce them
 * because the tests flip the inputs and vary the Python-level constants.
 */

/**
 * Bang-bang thermostat: drive the heater HIGH while the sensor reads below a
 * threshold, LOW otherwise. The THRESHOLD is a Python-level constant — varying
 * it (with the ADC value held fixed) must move the decision boundary, proving
 * the firmware's own branch decided the output (not a canned JS stub).
 */
export function thermostatFirmware(opts: {
  adcPin: number;
  heaterPin: number;
  threshold: number;
}): string {
  const { adcPin, heaterPin, threshold } = opts;
  return [
    "import machine",
    "",
    `_sensor = machine.ADC(${adcPin})`,
    `_heater = machine.Pin(${heaterPin}, machine.Pin.OUT)`,
    `THRESHOLD = ${threshold}`,
    "",
    "def setup():",
    "    _heater.value(0)",
    "",
    "def loop():",
    "    reading = _sensor.read_u16()",
    "    if reading < THRESHOLD:",
    "        _heater.value(1)",
    "    else:",
    "        _heater.value(0)",
    "",
  ].join("\n");
}

/**
 * Same thermostat, but each loop first calls `time.sleep_ms(sleepMs)` (MicroPython
 * puts sleeps on the `time`/`utime` module, not `machine`). Under the virtual
 * clock this must return immediately; a runtime that honoured the sleep against
 * the wall clock would take `steps * sleepMs` real milliseconds and blow a tight
 * time bound. The thermostat logic still runs so the step is proven to have
 * executed (not skipped).
 */
export function sleepingThermostatFirmware(opts: {
  adcPin: number;
  heaterPin: number;
  threshold: number;
  sleepMs: number;
}): string {
  const { adcPin, heaterPin, threshold, sleepMs } = opts;
  return [
    "import machine",
    "import time",
    "",
    `_sensor = machine.ADC(${adcPin})`,
    `_heater = machine.Pin(${heaterPin}, machine.Pin.OUT)`,
    `THRESHOLD = ${threshold}`,
    `SLEEP_MS = ${sleepMs}`,
    "",
    "def setup():",
    "    _heater.value(0)",
    "",
    "def loop():",
    "    time.sleep_ms(SLEEP_MS)",
    "    reading = _sensor.read_u16()",
    "    _heater.value(1 if reading < THRESHOLD else 0)",
    "",
  ].join("\n");
}

/**
 * Virtual-clock probe: read `machine.ticks_ms()` and write its little-endian
 * bits onto `count` output pins `base .. base+count-1`. The test reconstructs
 * the integer and asserts it equals the VIRTUAL `timeMs` it injected for that
 * step — i.e. the firmware observes tick*stepMs, not the wall clock. Wall-clock
 * epoch ms would not match the small injected values; a canned stub would not
 * count at all.
 */
export function clockProbeFirmware(opts: { basePin: number; bits: number }): string {
  const { basePin, bits } = opts;
  return [
    "import machine",
    "",
    `_bits = [machine.Pin(${basePin} + i, machine.Pin.OUT) for i in range(${bits})]`,
    "",
    "def setup():",
    "    for p in _bits:",
    "        p.value(0)",
    "",
    "def loop():",
    "    t = machine.ticks_ms()",
    `    for i in range(${bits}):`,
    "        _bits[i].value((t >> i) & 1)",
    "",
  ].join("\n");
}
