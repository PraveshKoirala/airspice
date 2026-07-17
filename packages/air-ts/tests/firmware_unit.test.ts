/**
 * Unit tests for the firmware codegen port (src/emit/firmware.ts, mirroring
 * packages/core/src/air/firmware.py). Pins the behaviors the UI's Firmware tab
 * depends on:
 *   - PlatformIO settings resolve from the MCU registry (board is authoritative
 *     for a known part; the design's free-text <board> is the fallback),
 *   - the Arduino C++ main mirrors the oracle: task blocks in sorted-id order,
 *     read_adc -> analogRead(AIR_<SIGNAL>_ADC_PIN), battery_raw_to_mv convert,
 *     write_gpio pinMode/digitalWrite, delay ops, log prints, trailing period
 *     delay (60s -> 60000ms, unparseable -> 1000ms fallback),
 *   - the pinmap header defines ADC channel/pin + I2C pin macros,
 *   - language="micropython" renders a main.py from the SAME task IR,
 *   - a design with no firmware section emits the idle loop.
 */

import { describe, it, expect } from "vitest";
import {
  parse,
  emitFirmware,
  emitMainCpp,
  emitMainPy,
  emitPinmapHeader,
  firmwarePlatformioSettings,
  resolveBindings,
  periodToMs,
} from "../src/index.js";

const BATTERY_DESIGN = `<?xml version="1.0" encoding="UTF-8"?>
<system name="esp32_battery_sensor" ir_version="0.1">
  <metadata>
    <title>ESP32 Battery Sensor</title>
    <description>Battery sensor.</description>
    <author>AIR</author>
    <created_at>2026-06-06T00:00:00Z</created_at>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="bat" role="power" nominal_voltage="3.7V"/>
    <net id="battery_sense" role="analog_signal"/>
    <net id="i2c_sda" role="digital_signal"/>
    <net id="i2c_scl" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="bat"/>
      <pin name="GND" net="gnd"/>
      <pin name="GPIO4" net="battery_sense" function="ADC1_CH4"/>
      <pin name="GPIO8" net="i2c_sda" function="I2C_SDA"/>
      <pin name="GPIO9" net="i2c_scl" function="I2C_SCL"/>
    </component>
  </components>
  <firmware>
    <project id="fw_main" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
    <binding id="battery_adc_binding">
      <signal name="battery_voltage"/>
      <component ref="U_MCU"/>
      <peripheral>ADC1</peripheral>
      <channel>ADC1_CH4</channel>
      <net>battery_sense</net>
    </binding>
    <task id="read_battery" target="fw_main">
      <period>60s</period>
      <read_adc binding="battery_adc_binding" into="battery_raw"/>
      <convert expr="battery_raw_to_mv(battery_raw)" into="battery_mv"/>
      <log value="battery_mv"/>
    </task>
    <task id="blink" target="fw_main">
      <period>250ms</period>
      <write_gpio pin="GPIO2" value="high"/>
      <delay duration="100ms"/>
      <write_gpio pin="GPIO2" value="low"/>
    </task>
  </firmware>
  <tests>
    <test id="t"><run duration="1ms"/></test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true"><backend type="ngspice"/></profile>
  </simulation_profiles>
</system>`;

describe("firmwarePlatformioSettings", () => {
  it("resolves platform/framework/board from the MCU registry", () => {
    const ir = parse(BATTERY_DESIGN);
    expect(firmwarePlatformioSettings(ir)).toEqual({
      platform: "espressif32",
      framework: "arduino",
      board: "esp32-c3-devkitm-1",
    });
  });

  it("falls back to the design board, then the ESP32-C3 default, for unknown parts", () => {
    const ir = parse(
      BATTERY_DESIGN.replace('part="ESP32-C3"', 'part="MYSTERY-MCU"'),
    );
    const settings = firmwarePlatformioSettings(ir);
    expect(settings.board).toBe("esp32-c3-devkitm-1"); // from <board>, same string
    expect(settings.platform).toBe("espressif32");
    const irNoBoard = parse(
      BATTERY_DESIGN.replace('part="ESP32-C3"', 'part="MYSTERY-MCU"').replace(
        "<board>esp32-c3-devkitm-1</board>",
        "<board>my-custom-board</board>",
      ),
    );
    expect(firmwarePlatformioSettings(irNoBoard).board).toBe("my-custom-board");
  });
});

describe("emitMainCpp (oracle _main_cpp parity)", () => {
  const ir = parse(BATTERY_DESIGN);
  const main = emitMainCpp(ir);

  it("reads the ADC through the binding's pin macro", () => {
    expect(main).toContain("int battery_raw = analogRead(AIR_BATTERY_VOLTAGE_ADC_PIN);");
  });

  it("routes battery_raw_to_mv converts through the helper", () => {
    expect(main).toContain("long battery_mv = battery_raw_to_mv(battery_raw);");
    expect(main).toContain("static long battery_raw_to_mv(int raw)");
  });

  it("logs name=value over serial", () => {
    expect(main).toContain('Serial.print("battery_mv=");');
    expect(main).toContain("Serial.println(battery_mv);");
  });

  it("converts the task period to a trailing delay (60s -> 60000)", () => {
    expect(main).toContain("delay(60000);");
  });

  it("emits write_gpio as digitalWrite and declares pinMode in setup", () => {
    expect(main).toContain("digitalWrite(2, HIGH);");
    expect(main).toContain("digitalWrite(2, LOW);");
    expect(main).toContain("pinMode(2, OUTPUT);");
    expect(main).toContain("delay(100);"); // the <delay duration="100ms"/> op
  });

  it("orders task blocks by sorted task id (blink before read_battery)", () => {
    expect(main.indexOf("// Task: blink")).toBeLessThan(main.indexOf("// Task: read_battery"));
  });

  it("falls back to the idle loop when there are no tasks", () => {
    const bare = parse(
      BATTERY_DESIGN.replace(/<task[\s\S]*?<\/task>/g, ""),
    );
    const idle = emitMainCpp(bare);
    expect(idle).toContain('Serial.println("air_status=idle");');
    expect(idle).toContain("delay(1000);");
  });
});

describe("emitPinmapHeader (oracle _pinmap parity)", () => {
  it("defines ADC channel/pin macros and I2C pins from MCU pin functions", () => {
    const header = emitPinmapHeader(parse(BATTERY_DESIGN));
    expect(header).toContain("#define AIR_BATTERY_VOLTAGE_ADC_CHANNEL ADC1_CH4");
    expect(header).toContain("#define AIR_BATTERY_VOLTAGE_ADC_PIN 4");
    expect(header).toContain("#define AIR_I2C_SDA_PIN 8");
    expect(header).toContain("#define AIR_I2C_SCL_PIN 9");
    expect(header.startsWith("#pragma once\n")).toBe(true);
    expect(header.endsWith("\n")).toBe(true);
  });
});

describe("emitFirmware", () => {
  it("emits the PlatformIO C++ tree for language=cpp", () => {
    const files = emitFirmware(parse(BATTERY_DESIGN));
    expect(files.map((f) => f.path)).toEqual([
      "platformio.ini",
      "include/air_pinmap.h",
      "include/air_config.h",
      "src/main.cpp",
    ]);
    const ini = files[0]!.content;
    expect(ini).toContain("[env:esp32-c3-devkitm-1]");
    expect(ini).toContain("platform = espressif32");
    expect(ini).toContain("framework = arduino");
    expect(files[2]!.content).toContain("#define AIR_UART_BAUD 115200");
  });

  it("emits main.py for language=micropython from the same task IR", () => {
    const ir = parse(BATTERY_DESIGN.replace('language="cpp"', 'language="micropython"'));
    const files = emitFirmware(ir);
    expect(files.map((f) => f.path)).toEqual(["src/main.py"]);
    const py = files[0]!.content;
    expect(py).toContain("adc_battery_voltage = ADC(Pin(4))");
    expect(py).toContain("battery_raw = adc_battery_voltage.read()");
    expect(py).toContain("battery_mv = battery_raw_to_mv(battery_raw)");
    expect(py).toContain('print("battery_mv=", battery_mv)');
    expect(py).toContain("time.sleep_ms(60000)");
    expect(py).toContain("pin_2 = Pin(2, Pin.OUT)");
    expect(py).toContain("pin_2.value(1)");
  });

  it("also handles a firmware-less design (idle C++ loop, empty pinmap)", () => {
    const ir = parse(
      BATTERY_DESIGN.replace(/<firmware>[\s\S]*<\/firmware>/, ""),
    );
    const files = emitFirmware(ir);
    const main = files.find((f) => f.path === "src/main.cpp")!;
    expect(main.content).toContain("air_status=idle");
  });
});

describe("helpers", () => {
  it("periodToMs mirrors _period_to_ms (incl. the 1000ms fallback)", () => {
    expect(periodToMs("60s")).toBe(60000);
    expect(periodToMs("250ms")).toBe(250);
    expect(periodToMs("250")).toBe(250);
    expect(periodToMs(" 5s ")).toBe(5000);
    expect(periodToMs("soon")).toBe(1000);
    expect(periodToMs("")).toBe(1000);
  });

  it("resolveBindings resolves the MCU pin backing each binding channel", () => {
    const [binding] = resolveBindings(parse(BATTERY_DESIGN));
    expect(binding).toMatchObject({
      id: "battery_adc_binding",
      signal: "battery_voltage",
      component: "U_MCU",
      peripheral: "ADC1",
      channel: "ADC1_CH4",
      net: "battery_sense",
      pinName: "GPIO4",
    });
  });

  it("convert without a call expression assigns from the first task variable", () => {
    const ir = parse(
      BATTERY_DESIGN.replace(
        'expr="battery_raw_to_mv(battery_raw)"',
        'expr="scaled"',
      ),
    );
    const main = emitMainCpp(ir);
    // No (...) group in the expr -> source falls back to the first variable
    // the task defined (battery_raw), mirroring the oracle's next(iter(vars)).
    expect(main).toContain("long battery_mv = battery_raw;");
  });

  it("emitMainPy emits the idle loop when there are no tasks", () => {
    const ir = parse(BATTERY_DESIGN.replace(/<task[\s\S]*?<\/task>/g, ""));
    const py = emitMainPy(ir);
    expect(py).toContain('print("air_status=idle")');
    expect(py).toContain("time.sleep_ms(1000)");
  });
});
