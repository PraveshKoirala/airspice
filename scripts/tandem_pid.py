"""PID heater controller through the full PlatformIO + ngspice + Renode tandem.

The agent authors a real PID controller (its algorithm); we constrain only the
target I/O so it runs under Renode's minimal STM32F103 model. Then we inject two
thermistor readings (a cold and a hot one) via the emulated ADC and assert the
fundamental closed-loop property: the colder reading commands MORE heater duty.
"""
from __future__ import annotations

import re
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")
from air.agent import run_ai_firmware, validate_design_xml  # noqa: E402

RENODE_TEST = "C:/Users/prave/.gemini/tools/renode/renode_1.16.1-dotnet_portable/renode-test.bat"
WORK = ROOT / "generated" / "tandem" / "pid"
PERIPH = ROOT / "generated" / "tandem" / "peripherals.repl"

PID_DESIGN = """<system name="pid_heater_stm32" ir_version="0.1">
  <metadata><title>STM32 PID Heater</title><description>Closed-loop heater controller</description><author>AIR</author><created_at>2026-01-01T00:00:00Z</created_at></metadata>
  <nets>
    <net id="v3v3" role="power" nominal_voltage="3.3V"/>
    <net id="gnd" role="ground"/>
    <net id="therm" role="analog_signal"/>
    <net id="heat" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="STM32F103">
      <pin name="VDD" net="v3v3"/><pin name="VSS" net="gnd"/>
      <pin name="PA0" net="therm" function="ADC1_CH0"/>
      <pin name="PA1" net="heat" function="GPIO"/>
    </component>
    <component id="R_NTC" type="resistor"><value>100k</value><pin name="1" net="v3v3"/><pin name="2" net="therm"/></component>
    <component id="R_SER" type="resistor"><value>100k</value><pin name="1" net="therm"/><pin name="2" net="gnd"/></component>
    <component id="Q_HEAT" type="mosfet" spice_model="NMOS"><pin name="G" net="heat"/><pin name="D" net="v3v3"/><pin name="S" net="gnd"/></component>
  </components>
  <tests><test id="t"><setup><set_voltage net="v3v3" value="3.3V"/></setup><run duration="1ms"/><assert_voltage net="therm" min="0V" max="3.3V"/></test></tests>
  <simulation_profiles><profile id="analog_only" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>"""

PID_SPEC = """Implement a PID temperature controller for an STM32F103 driving a heater.

TARGET I/O - use EXACTLY this scaffolding so it runs on the bare hardware:
- Telemetry: HardwareSerial uart1(PA10, PA9); uart1.begin(115200) in setup().
- ADC: enable once in setup with `RCC->APB2ENR |= RCC_APB2ENR_ADC1EN; ADC1->CR2 |= ADC_CR2_ADON;`.
  Read the thermistor each loop by reading the data register DIRECTLY:
  `ADC1->CR2 |= ADC_CR2_ADON; int raw = ADC1->DR & 0x0FFF;`  (DO NOT use analogRead).
- Print exactly one line per loop in this format (integers): `TEMP=<celsius> DUTY=<0..255>`.

ALGORITHM (your work):
- Convert raw (0..4095, 3.3V ref) to temperature in Celsius for a 100k NTC with a 100k
  series resistor using the beta equation (beta 3950, 25C nominal).
- Run a PID loop at a fixed millis() interval toward a setpoint of 50 C, with Kp/Ki/Kd
  constants and integral anti-windup (clamp the integral term).
- Compute heater duty as the PID output clamped to 0..255. Over-temperature safety: if
  temperature exceeds 80 C, force duty to 0. You may also call analogWrite(PA1, duty).
- delay ~100 ms per loop.
"""


def author_firmware() -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    design = WORK / "design.air.xml"
    ok, diags = validate_design_xml(PID_DESIGN)
    print(f"PID design valid: {ok}", "" if ok else [d["code"] for d in diags if d.get("severity") == "error"])
    design.write_text(PID_DESIGN, encoding="utf-8")
    fw = run_ai_firmware(design, PID_SPEC, WORK / "fw", provider="gemini")
    print(f"firmware: compiled={fw.get('compiled')} iterations={fw.get('iterations')}")
    elf = WORK / "fw" / "build" / "firmware" / ".pio" / "build" / "bluepill_f103c8" / "firmware.elf"
    return elf if fw.get("compiled") and elf.exists() else None


def capture(elf: Path, counts: int) -> str:
    out = WORK / "renode" / f"c{counts}"
    out.mkdir(parents=True, exist_ok=True)
    cap = (out / "uart.log").as_posix()
    robot = out / "case.robot"
    robot.write_text(
        f"""*** Settings ***
Suite Setup       Setup
Suite Teardown    Teardown
Resource          ${{RENODEKEYWORDS}}
*** Test Cases ***
Cap
    Execute Command    mach create
    Execute Command    machine LoadPlatformDescription @platforms/cpus/stm32f103.repl
    Execute Command    machine LoadPlatformDescription @{PERIPH.as_posix()}
    Execute Command    sysbus LoadELF @{elf.as_posix()}
    Execute Command    sysbus.usart1 CreateFileBackend @{cap}
    Execute Command    sysbus.adc1 WriteDoubleWord 0x100 {counts}
    Execute Command    start
    Sleep              3s
    Execute Command    pause
""",
        encoding="utf-8",
    )
    subprocess.run([RENODE_TEST, str(robot)], capture_output=True, text=True, cwd=ROOT)
    return (out / "uart.log").read_text(encoding="utf-8") if (out / "uart.log").exists() else ""


def last_reading(uart: str):
    temp = duty = None
    for line in uart.splitlines():
        m = re.search(r"TEMP=(-?\d+)\s+DUTY=(\d+)", line)
        if m:
            temp, duty = int(m.group(1)), int(m.group(2))
    return temp, duty


def main() -> int:
    print("=== PID heater through PlatformIO + ngspice + Renode tandem ===")
    elf = author_firmware()
    if not elf:
        print("FAIL: firmware did not compile")
        return 1
    cold_t, cold_d = last_reading(capture(elf, 300))    # low ADC count
    hot_t, hot_d = last_reading(capture(elf, 3800))     # high ADC count
    print(f"  cold inject(300):  TEMP={cold_t} DUTY={cold_d}")
    print(f"  hot  inject(3800): TEMP={hot_t} DUTY={hot_d}")
    if None in (cold_t, cold_d, hot_t, hot_d):
        print("FAIL: could not parse TEMP/DUTY telemetry")
        return 1
    # Identify which injection read colder, and assert it commands >= heater duty.
    if cold_t == hot_t:
        print("FAIL: temperature did not differ between injections")
        return 1
    colder_duty = cold_d if cold_t < hot_t else hot_d
    warmer_duty = hot_d if cold_t < hot_t else cold_d
    ok = colder_duty >= warmer_duty and colder_duty != warmer_duty
    print(f"\n[{'OK' if ok else 'FAIL'}] PID closed-loop: colder reading commands more heat "
          f"(colder DUTY={colder_duty} >= warmer DUTY={warmer_duty})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
