"""Full mixed-signal tandem: PlatformIO + ngspice + Renode in one loop.

For each case: ngspice simulates an analog divider to get a node voltage, that
voltage is converted to ADC counts and injected into the firmware running in
Renode (built by PlatformIO), and we assert the firmware's USART decision matches
what the analog voltage implies. This exercises all three tools together.
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
from air.parser import parse_string  # noqa: E402
from air.simulator import simulate_analog  # noqa: E402

RENODE_TEST = "C:/Users/prave/.gemini/tools/renode/renode_1.16.1-dotnet_portable/renode-test.bat"
TANDEM = ROOT / "generated" / "tandem"
ELF = TANDEM / "fw" / ".pio" / "build" / "bluepill_f103c8" / "firmware.elf"
PERIPH = TANDEM / "peripherals.repl"
VREF = 3.3
ADC_MAX = 4095
THRESHOLD_MV = 1650


def _divider_design(name: str, r_top: str, r_bot: str) -> str:
    return f"""<system name="{name}" ir_version="0.1">
  <metadata><title>{name}</title><description>d</description><author>a</author><created_at>2026-01-01T00:00:00Z</created_at></metadata>
  <nets><net id="vin" role="power" nominal_voltage="3.3V"/><net id="sense" role="analog_signal"/><net id="gnd" role="ground"/></nets>
  <components>
    <component id="VS" type="voltage_source"><value>3.3V</value><pin name="p" net="vin"/><pin name="n" net="gnd"/></component>
    <component id="RT" type="resistor"><value>{r_top}</value><pin name="1" net="vin"/><pin name="2" net="sense"/></component>
    <component id="RB" type="resistor"><value>{r_bot}</value><pin name="1" net="sense"/><pin name="2" net="gnd"/></component>
  </components>
  <tests><test id="t"><setup><set_voltage net="vin" value="3.3V"/></setup><run duration="1ms"/><assert_voltage net="sense" min="0V" max="3.3V"/></test></tests>
  <simulation_profiles><profile id="analog_only" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>"""


def ngspice_node_voltage(design_xml: str, out_dir: Path) -> float:
    ir, _ = parse_string(design_xml)
    result = simulate_analog(ir, "analog_only", out_dir)
    measured = result["reports"][0]["measurements"]
    raw = measured.get("sense", "0V")
    return float(re.sub(r"[^0-9.\-]", "", raw))


def run_renode_capture(counts: int, out_dir: Path) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    cap = (out_dir / "uart.log").as_posix()
    robot = out_dir / "case.robot"
    robot.write_text(
        f"""*** Settings ***
Suite Setup       Setup
Suite Teardown    Teardown
Resource          ${{RENODEKEYWORDS}}

*** Test Cases ***
Capture
    Execute Command    mach create
    Execute Command    machine LoadPlatformDescription @platforms/cpus/stm32f103.repl
    Execute Command    machine LoadPlatformDescription @{PERIPH.as_posix()}
    Execute Command    sysbus LoadELF @{ELF.as_posix()}
    Execute Command    sysbus.usart1 CreateFileBackend @{cap}
    Execute Command    start
    Sleep              1s
    Execute Command    sysbus.adc1 WriteDoubleWord 0x100 {counts}
    Sleep              2s
    Execute Command    pause
""",
        encoding="utf-8",
    )
    subprocess.run([RENODE_TEST, str(robot)], capture_output=True, text=True, cwd=ROOT)
    return (out_dir / "uart.log").read_text(encoding="utf-8") if (out_dir / "uart.log").exists() else ""


def run_case(name: str, r_top: str, r_bot: str) -> bool:
    work = TANDEM / "cases" / name
    design = _divider_design(name, r_top, r_bot)
    voltage = ngspice_node_voltage(design, work / "ngspice")
    counts = max(0, min(ADC_MAX, round(voltage / VREF * ADC_MAX)))
    expected = "HIGH" if voltage * 1000 > THRESHOLD_MV else "LOW"
    uart = run_renode_capture(counts, work / "renode")
    # The firmware echoes the injected count; confirm it read OUR value and decided right.
    matched_line = next((ln for ln in uart.splitlines() if f"raw={counts}" in ln), "")
    ok = bool(matched_line) and (f"STATE={expected}" in matched_line)
    print(f"[{'OK ' if ok else 'FAIL'}] {name:16} ngspice sense={voltage:.3f}V -> {counts} counts "
          f"-> firmware: '{matched_line.strip()}' (expected STATE={expected})")
    return ok


def main() -> int:
    print("=== Mixed-signal tandem: PlatformIO + ngspice + Renode ===")
    cases = [
        ("high_divider", "10k", "22k"),   # 3.3*22/32 = 2.27V -> HIGH
        ("low_divider", "22k", "10k"),    # 3.3*10/32 = 1.03V -> LOW
    ]
    results = [run_case(n, rt, rb) for n, rt, rb in cases]
    passed = sum(results)
    print(f"\nCases passed: {passed}/{len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
