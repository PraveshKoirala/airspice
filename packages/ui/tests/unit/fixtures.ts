/**
 * Shared design fixtures for the #126/#127 history + inspector unit tests.
 *
 * `DEFAULT_DESIGN_XML` is the app's built-in default design (App.tsx
 * DEFAULT_XML) -- a fully-valid AIR document (all required sections present),
 * so `runGate` / `commitPatch` accept edits against it without rejecting on a
 * pre-existing diagnostic.
 *
 * `buildLargeDesign(count)` pads the <components> section with `count` extra
 * resistors (each a valid parallel bat->gnd resistor) so the canonical
 * document grows to many KB. That size gap is what the #126 minimal-patch
 * MEMORY assertion measures: a single-attribute edit on this large design must
 * record undo/redo PATCH strings far smaller than the whole document.
 */

export const DEFAULT_DESIGN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<system name="esp32_battery_sensor" ir_version="0.1">
  <metadata>
    <title>ESP32 Battery Sensor</title>
    <description>Battery-powered ESP32-C3 sensor node with ADC battery measurement.</description>
    <author>AIR</author>
    <created_at>2026-06-06T00:00:00Z</created_at>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="bat" role="power" nominal_voltage="3.7V"/>
    <net id="3v3" role="power" nominal_voltage="3.3V"/>
    <net id="battery_sense" role="analog_signal"/>
    <net id="i2c_sda" role="digital_signal"/>
    <net id="i2c_scl" role="digital_signal"/>
  </nets>
  <power_domains>
    <domain id="logic_3v3" net="3v3" nominal="3.3V" source="U_REG.out"/>
  </power_domains>
  <components>
    <component id="R_BAT_TOP" type="resistor">
      <value>1M</value>
      <pin name="1" net="bat"/>
      <pin name="2" net="battery_sense"/>
    </component>
    <component id="R_BAT_BOTTOM" type="resistor">
      <value>330k</value>
      <pin name="1" net="battery_sense"/>
      <pin name="2" net="gnd"/>
    </component>
    <component id="C_BAT_SENSE" type="capacitor">
      <value>100nF</value>
      <pin name="1" net="battery_sense"/>
      <pin name="2" net="gnd"/>
    </component>
    <component id="U_REG" type="ldo" part="generic_ldo_3v3">
      <pin name="in" net="bat"/>
      <pin name="out" net="3v3"/>
      <pin name="gnd" net="gnd"/>
      <property name="vout" value="3.3V"/>
      <property name="iout_max" value="700mA"/>
      <property name="v_dropout" value="200mV"/>
      <property name="iq" value="10uA"/>
    </component>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="3v3"/>
      <pin name="GND" net="gnd"/>
      <pin name="GPIO4" net="battery_sense" function="ADC1_CH4"/>
      <pin name="GPIO8" net="i2c_sda" function="I2C_SDA"/>
      <pin name="GPIO9" net="i2c_scl" function="I2C_SCL"/>
    </component>
  </components>
  <interfaces>
    <interface id="i2c0" type="i2c">
      <controller component="U_MCU" peripheral="I2C0"/>
      <sda net="i2c_sda"/>
      <scl net="i2c_scl"/>
      <pullup net="i2c_sda" value="4.7k" to="3v3"/>
      <pullup net="i2c_scl" value="4.7k" to="3v3"/>
    </interface>
  </interfaces>
  <analog>
    <subsystem id="battery_measurement">
      <uses component="R_BAT_TOP"/>
      <uses component="R_BAT_BOTTOM"/>
      <uses component="C_BAT_SENSE"/>
      <probe id="probe_battery_sense" net="battery_sense" quantity="voltage"/>
    </subsystem>
  </analog>
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
  </firmware>
  <tests>
    <test id="battery_adc_nominal">
      <setup><set_voltage net="bat" value="4.2V"/></setup>
      <run duration="500ms"/>
      <assert_voltage net="battery_sense" min="1.02V" max="1.06V"/>
    </test>
    <test id="rail_startup">
      <setup><set_voltage net="bat" value="3.7V"/></setup>
      <run duration="100ms"/>
      <assert_voltage net="3v3" min="3.0V" max="3.6V"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <include subsystem="battery_measurement"/>
      <run test="battery_adc_nominal"/>
      <run test="rail_startup"/>
    </profile>
  </simulation_profiles>
</system>`;

/** Zero-padded id for the i-th padding resistor, e.g. `R_PAD040`. */
export function padId(i: number): string {
  return "R_PAD" + String(i).padStart(3, "0");
}

/**
 * Build a valid design with `count` extra resistors appended to <components>.
 * Each padding resistor is a benign parallel bat->gnd resistor, so the
 * document stays schema-valid (verified against air-ts `validate`) while
 * growing large enough that the 25%-of-document memory threshold is a
 * meaningful gap.
 */
export function buildLargeDesign(count: number): string {
  const pads: string[] = [];
  for (let i = 0; i < count; i++) {
    pads.push(
      `    <component id="${padId(i)}" type="resistor">\n` +
        `      <value>1k</value>\n` +
        `      <pin name="1" net="bat"/>\n` +
        `      <pin name="2" net="gnd"/>\n` +
        `    </component>`,
    );
  }
  return DEFAULT_DESIGN_XML.replace(
    "  </components>",
    pads.join("\n") + "\n  </components>",
  );
}
