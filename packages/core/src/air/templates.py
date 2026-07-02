from __future__ import annotations

from pathlib import Path


TEMPLATE_NAMES = [
    "esp32-battery-sensor",
    "esp32-i2c-sensor",
    "voltage-divider",
    "overloaded-rail",
]


def render_template(name: str) -> str:
    if name == "esp32-battery-sensor":
        example = Path(__file__).resolve().parents[4] / "examples" / "esp32_battery_sensor" / "design.air.xml"
        return example.read_text(encoding="utf-8")
    if name == "esp32-i2c-sensor":
        return _esp32_i2c_sensor()
    if name == "voltage-divider":
        return _voltage_divider()
    if name == "overloaded-rail":
        example = Path(__file__).resolve().parents[4] / "examples" / "failing" / "overloaded_3v3_rail.air.xml"
        return example.read_text(encoding="utf-8")
    raise ValueError(f"Unknown template '{name}'. Available templates: {', '.join(TEMPLATE_NAMES)}")


def _voltage_divider() -> str:
    return """<system name="simple_voltage_divider" ir_version="0.1">
  <metadata>
    <title>Simple Voltage Divider</title>
    <description>Passive divider from 5V to approximately 2.5V.</description>
    <author>AIR</author>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="vin" role="power" nominal_voltage="5V"/>
    <net id="vout" role="analog_signal"/>
  </nets>
  <components>
    <component id="R_TOP" type="resistor">
      <value>10k</value>
      <pin name="1" net="vin"/>
      <pin name="2" net="vout"/>
    </component>
    <component id="R_BOTTOM" type="resistor">
      <value>10k</value>
      <pin name="1" net="vout"/>
      <pin name="2" net="gnd"/>
    </component>
  </components>
  <analog>
    <subsystem id="divider">
      <uses component="R_TOP"/>
      <uses component="R_BOTTOM"/>
      <probe id="probe_vout" net="vout" quantity="voltage"/>
    </subsystem>
  </analog>
  <tests>
    <test id="divider_nominal">
      <setup><set_voltage net="vin" value="5V"/></setup>
      <run duration="10ms"/>
      <assert_voltage net="vout" min="2.45V" max="2.55V"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <include subsystem="divider"/>
      <run test="divider_nominal"/>
    </profile>
  </simulation_profiles>
</system>
"""


def _esp32_i2c_sensor() -> str:
    return """<system name="esp32_i2c_sensor" ir_version="0.1">
  <metadata>
    <title>ESP32-C3 I2C Sensor Node</title>
    <description>ESP32-C3 with a 3V3 rail and I2C sensor bus.</description>
    <author>AIR</author>
  </metadata>
  <nets>
    <net id="gnd" role="ground"/>
    <net id="bat" role="power" nominal_voltage="3.7V"/>
    <net id="3v3" role="power" nominal_voltage="3.3V"/>
    <net id="i2c_sda" role="digital_signal"/>
    <net id="i2c_scl" role="digital_signal"/>
  </nets>
  <power_domains>
    <domain id="logic_3v3" net="3v3" nominal="3.3V" source="U_REG.out"/>
  </power_domains>
  <components>
    <component id="U_REG" type="ldo" part="generic_ldo_3v3">
      <pin name="in" net="bat"/>
      <pin name="out" net="3v3"/>
      <pin name="gnd" net="gnd"/>
      <property name="vout" value="3.3V"/>
      <property name="iout_max" value="500mA"/>
      <property name="v_dropout" value="200mV"/>
      <property name="iq" value="10uA"/>
    </component>
    <component id="U_MCU" type="mcu" part="ESP32-C3">
      <pin name="3V3" net="3v3"/>
      <pin name="GND" net="gnd"/>
      <pin name="GPIO8" net="i2c_sda" function="I2C_SDA"/>
      <pin name="GPIO9" net="i2c_scl" function="I2C_SCL"/>
    </component>
    <component id="U_SENSOR" type="sensor" part="generic_i2c_sensor">
      <pin name="VCC" net="3v3"/>
      <pin name="GND" net="gnd"/>
      <pin name="SDA" net="i2c_sda"/>
      <pin name="SCL" net="i2c_scl"/>
    </component>
  </components>
  <interfaces>
    <interface id="i2c0" type="i2c">
      <controller component="U_MCU" peripheral="I2C0"/>
      <sda net="i2c_sda"/>
      <scl net="i2c_scl"/>
      <pullup net="i2c_sda" value="4.7k" to="3v3"/>
      <pullup net="i2c_scl" value="4.7k" to="3v3"/>
      <device component="U_SENSOR" address="0x76"/>
    </interface>
  </interfaces>
  <firmware>
    <project id="fw_main" target="U_MCU" framework="platformio" language="cpp">
      <board>esp32-c3-devkitm-1</board>
    </project>
  </firmware>
  <tests>
    <test id="rail_startup">
      <setup><set_voltage net="bat" value="3.7V"/></setup>
      <run duration="100ms"/>
      <assert_voltage net="3v3" min="3.0V" max="3.6V"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <run test="rail_startup"/>
    </profile>
  </simulation_profiles>
</system>
"""
