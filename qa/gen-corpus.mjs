// Deterministic generator for the circuit-refinement corpus.
//
//   node qa/gen-corpus.mjs > qa/circuit-corpus/prompts.json
//
// Produces 100 natural-language circuit-build prompts a real engineer might type
// into the AirSpice AI Assistant. 84 include an MCU + firmware (spread across
// the 4 registry-supported parts); 16 are pure-analog. Prompts are written to
// stay inside what the engine actually models: SPICE primitives (R, C, diode,
// LED-as-load, MOSFET, LDO, sources) for the analog front-end, and the four
// MCUs with their real ADC references so ADC bindings never exceed vref.
//
// Every spec carries expectations the harness asserts against:
//   expectStaged   - the agent MUST stage a valid design (true for all)
//   expectFirmware - the Firmware tab MUST render a project (MCU circuits)
//   expectSimPass  - sim SHOULD pass (true only when a simulatable analog
//                    front-end fully determines the probed nets; false for
//                    pure-actuator firmware whose nets are driven by the
//                    non-simulated MCU, where a sim non-pass is NOT a bug)
//
// Reproducible: no randomness; all variation is index-derived.

// The 4 MCUs the registry models, with their ADC reference and a supply rail
// the firmware logic runs on. (data.generated.ts is the source of truth.)
const MCUS = [
  { part: "ESP32-C3", vref: 3.3, rail: "3.3V", desc: "ESP32-C3 (RISC-V)" },
  { part: "ESP32-WROOM-32", vref: 3.3, rail: "3.3V", desc: "ESP32-WROOM-32" },
  { part: "ATmega328P", vref: 5.0, rail: "5V", desc: "ATmega328P (Arduino Uno)" },
  { part: "STM32F103", vref: 3.3, rail: "3.3V", desc: "STM32F103 (Blue Pill)" },
];

// Firmware/circuit templates. Each returns a natural-language prompt given an
// MCU and a variation index. `sim` = whether the probed analog front-end fully
// determines the result (so we can assert sim passes).
const MCU_TEMPLATES = [
  {
    key: "vbat_monitor",
    sim: true,
    lang: (m, i) => {
      const src = [6, 9, 12, 7.4][i % 4];
      const per = [1, 2, 5, 10][i % 4];
      return `Design a ${src}V battery voltage monitor built around a ${m.desc}. Regulate ${src}V down to the ${m.rail} logic rail with an LDO, and use a resistor divider to scale the raw ${src}V battery down to well under the MCU's ${m.vref}V ADC reference. Probe the divider midpoint. Write firmware that reads the battery voltage on an ADC pin every ${per} seconds, converts the raw count to millivolts, and logs it.`;
    },
  },
  {
    key: "thermistor",
    sim: true,
    lang: (m, i) => {
      const rfixed = ["10k", "4.7k", "22k", "100k"][i % 4];
      const per = [2, 3, 5, 15][i % 4];
      return `Build an NTC thermistor temperature sensor node using a ${m.desc} on a ${m.rail} rail. Put the ${rfixed} NTC thermistor (model it as a resistor) in a divider with a ${rfixed} fixed resistor between ${m.rail} and ground so the sense node stays under ${m.vref}V, and probe the sense node. Firmware should sample the thermistor voltage on an ADC channel every ${per} seconds, convert to a temperature estimate, and log the value.`;
    },
  },
  {
    key: "photocell",
    sim: true,
    lang: (m, i) => {
      const per = [1, 2, 4, 8][i % 4];
      return `Create an ambient-light sensor using a ${m.desc}. Model a photoresistor (LDR) as a resistor in a divider with a fixed resistor from ${m.rail} to ground, keeping the sense node below the ${m.vref}V ADC reference, and probe it. The firmware reads the light level on an ADC pin every ${per} seconds and logs a brightness value.`;
    },
  },
  {
    key: "potentiometer",
    sim: true,
    lang: (m, i) => {
      const per = [1, 2, 3, 5][i % 4];
      return `Design a rotary knob input for a ${m.desc}. Model a potentiometer as a two-resistor divider from ${m.rail} to ground (wiper at the midpoint, kept under ${m.vref}V) and probe the wiper. Firmware samples the wiper on an ADC channel every ${per} seconds and logs the position.`;
    },
  },
  {
    key: "dual_adc",
    sim: true,
    lang: (m, i) => {
      const per = [1, 2, 5][i % 3];
      return `Build a dual-channel analog acquisition board on a ${m.desc} at ${m.rail}. Provide two independent resistor dividers from ${m.rail} to ground, each producing a distinct midpoint voltage under ${m.vref}V, and probe both. Firmware reads both ADC channels every ${per} seconds, converts each to millivolts, and logs both readings.`;
    },
  },
  {
    key: "rail_selfmonitor",
    sim: true,
    lang: (m, i) => {
      const src = [9, 12, 6][i % 3];
      const per = [5, 10, 30][i % 3];
      return `Design a power-supply supervisor: a ${src}V input feeds an LDO producing the ${m.rail} rail for a ${m.desc}, with input and output bypass capacitors. A resistor divider scales the ${src}V input down under ${m.vref}V into an ADC pin so the MCU can watch its own input voltage; probe that divider. Firmware reads the input-rail ADC every ${per} seconds, converts to millivolts, and logs it.`;
    },
  },
  {
    key: "led_blinker",
    sim: false,
    lang: (m, i) => {
      const on = [250, 500, 100, 1000][i % 4];
      return `Make a status-LED blinker on a ${m.desc} running from ${m.rail}. Drive an LED through a current-limiting resistor from a GPIO output pin to ground. The firmware should toggle the GPIO high for ${on}ms then low for ${on}ms in a loop to blink the LED.`;
    },
  },
  {
    key: "mosfet_load",
    sim: false,
    lang: (m, i) => {
      const per = [500, 1000, 2000][i % 3];
      return `Design a high-side... actually low-side load switch driven by a ${m.desc} on ${m.rail}. A GPIO output drives the gate of an N-channel MOSFET through a gate resistor; the MOSFET switches a resistive load (model it as a generic load) connected to a ${m.rail} rail. Firmware turns the load on for ${per}ms and off for ${per}ms repeatedly by toggling the GPIO.`;
    },
  },
  {
    key: "i2c_node",
    sim: true,
    lang: (m, i) => {
      const per = [1, 2, 5][i % 3];
      return `Build an I2C sensor node around a ${m.desc}. Bring out the I2C SDA and SCL lines with 4.7k pull-up resistors to the ${m.rail} rail, and add a resistor divider from ${m.rail} to ground (under ${m.vref}V) into an ADC pin as an auxiliary analog input; probe the divider. Firmware samples the aux ADC every ${per} seconds and logs it.`;
    },
  },
  {
    key: "heartbeat_plus_sense",
    sim: true,
    lang: (m, i) => {
      const per = [2, 4, 6][i % 3];
      return `Design a sensor node with a heartbeat LED on a ${m.desc} at ${m.rail}. Include a resistor divider from ${m.rail} to ground (kept under ${m.vref}V) into an ADC pin and probe it, plus an LED with series resistor on a GPIO output. Firmware reads the ADC every ${per} seconds, logs the value, and toggles the heartbeat LED each cycle.`;
    },
  },
];

// Pure-analog templates (no MCU).
const ANALOG_TEMPLATES = [
  {
    key: "rc_lowpass",
    sim: true,
    lang: (i) => {
      const r = ["1k", "10k", "4.7k"][i % 3];
      const c = ["10uF", "1uF", "100nF"][i % 3];
      const v = [5, 3.3, 12][i % 3];
      return `Build a passive RC low-pass filter: a ${v}V source drives a ${r} series resistor into a ${c} capacitor to ground. Probe the capacitor node and add a test that it charges toward the input within a reasonable settling time.`;
    },
  },
  {
    key: "divider",
    sim: true,
    lang: (i) => {
      const v = [9, 12, 5, 24][i % 4];
      const target = [3.3, 5, 2.5, 1.8][i % 4];
      return `Design a resistor voltage divider that steps ${v}V down to approximately ${target}V at the midpoint. Probe the midpoint and add a simulation test asserting it lands within 10% of ${target}V.`;
    },
  },
  {
    key: "led_rail",
    sim: false,
    lang: (i) => {
      const v = [5, 3.3, 12][i % 3];
      return `Create a simple indicator: a ${v}V rail drives an LED through a current-limiting resistor sized for about 10mA. Probe the LED anode.`;
    },
  },
  {
    key: "ldo_rail",
    sim: true,
    lang: (i) => {
      const vin = [9, 12, 6][i % 3];
      return `Design a regulated ${vin}V-to-3.3V power supply using an LDO with input and output bypass capacitors. Add a test that the 3.3V output rail is within 4.75% of nominal under a light resistive load.`;
    },
  },
  {
    key: "half_wave",
    sim: true,
    lang: (i) => {
      const v = [5, 9][i % 2];
      return `Build a half-wave rectifier front-end: a ${v}V source through a diode into an RC smoothing network (a resistor to a capacitor to ground). Probe the smoothed output node.`;
    },
  },
  {
    key: "mosfet_switch",
    sim: false,
    lang: (i) => {
      const v = [5, 12][i % 2];
      return `Design a MOSFET low-side switch: an N-channel MOSFET switches a resistive load from a ${v}V rail, with a gate resistor and a pull-down on the gate. Probe the drain node.`;
    },
  },
  {
    key: "cascaded_divider",
    sim: true,
    lang: (i) => {
      return `Build a two-stage cascaded resistor divider from 12V: the first stage halves to ~6V, the second stage halves again to ~3V. Probe both intermediate nodes and assert the final node is near 3V.`;
    },
  },
];

function build() {
  const specs = [];
  let n = 0;

  // 84 MCU circuits: iterate templates across MCUs to spread evenly.
  // 9 templates x 4 MCUs = 36 base; add a second pass with shifted variation
  // indices to reach 84 while keeping ~21 per MCU.
  const mcuTarget = 84;
  let ti = 0;
  let mi = 0;
  let vi = 0;
  while (specs.filter((s) => s.category === "mcu").length < mcuTarget) {
    const tpl = MCU_TEMPLATES[ti % MCU_TEMPLATES.length];
    const m = MCUS[mi % MCUS.length];
    const prompt = tpl.lang(m, vi);
    n += 1;
    specs.push({
      id: `mcu-${String(n).padStart(3, "0")}-${m.part.toLowerCase().replace(/[^a-z0-9]+/g, "")}-${tpl.key}`,
      title: `${m.part} ${tpl.key.replace(/_/g, " ")}`,
      category: "mcu",
      mcu: m.part,
      expectStaged: true,
      expectFirmware: true,
      expectSimPass: tpl.sim,
      prompt,
    });
    // advance: step MCU every template so each template hits all 4 MCUs,
    // and bump variation each full MCU cycle for diversity.
    mi += 1;
    if (mi % MCUS.length === 0) {
      ti += 1;
      if (ti % MCU_TEMPLATES.length === 0) vi += 1;
    }
  }

  // 16 analog circuits.
  let ai = 0;
  let av = 0;
  while (specs.filter((s) => s.category === "analog").length < 16) {
    const tpl = ANALOG_TEMPLATES[ai % ANALOG_TEMPLATES.length];
    const prompt = tpl.lang(av);
    n += 1;
    specs.push({
      id: `analog-${String(n).padStart(3, "0")}-${tpl.key}`,
      title: `analog ${tpl.key.replace(/_/g, " ")}`,
      category: "analog",
      mcu: null,
      expectStaged: true,
      expectFirmware: false,
      expectSimPass: tpl.sim,
      prompt,
    });
    ai += 1;
    if (ai % ANALOG_TEMPLATES.length === 0) av += 1;
  }

  return specs;
}

const specs = build();
// Sanity: counts.
const mcuCount = specs.filter((s) => s.category === "mcu").length;
const perMcu = {};
for (const s of specs) if (s.mcu) perMcu[s.mcu] = (perMcu[s.mcu] || 0) + 1;
process.stderr.write(
  `Generated ${specs.length} specs (${mcuCount} MCU, ${specs.length - mcuCount} analog). Per MCU: ${JSON.stringify(perMcu)}\n`,
);
process.stdout.write(JSON.stringify(specs, null, 2) + "\n");
