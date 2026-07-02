"""4 highly non-trivial real-world products through the PlatformIO+Renode tandem.

Each: the agent designs STM32F103 hardware and authors sophisticated control/DSP
firmware (its algorithm) constrained only on target I/O; we drive a TIME-VARYING
analog stimulus into the emulated ADC and assert genuinely stateful behavior
(hysteresis latch, PI closed-loop direction, debounced fault state machine,
Schmitt-trigger filter). The firmware echoes ADC=<counts> so each stimulus phase
is matched to its settled telemetry.
"""
from __future__ import annotations

import re
import subprocess
import sys
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")
from air.agent import run_ai_firmware, validate_design_xml  # noqa: E402

RENODE_TEST = "C:/Users/prave/.gemini/tools/renode/renode_1.16.1-dotnet_portable/renode-test.bat"
PERIPH = ROOT / "generated" / "tandem" / "peripherals.repl"
WORK = ROOT / "generated" / "tandem" / "apps"

IO_PREAMBLE = (
    "TARGET I/O - use EXACTLY this scaffolding so it runs on the bare STM32F103:\n"
    "- Telemetry over USART1: `HardwareSerial uart1(PA10, PA9);` and `uart1.begin(115200);` in setup().\n"
    "- ADC: in setup `RCC->APB2ENR |= RCC_APB2ENR_ADC1EN; ADC1->CR2 |= ADC_CR2_ADON;`.\n"
    "  Each loop read the input DIRECTLY: `ADC1->CR2 |= ADC_CR2_ADON; int adc = ADC1->DR & 0x0FFF;`"
    "  (0..4095). DO NOT use analogRead.\n"
    "- Print EXACTLY ONE line per loop, beginning with `ADC=<adc>` then a space and your integer "
    "fields in `KEY=<int>` form. Loop period ~50 ms.\n\n"
)


def stm32_sense_design(name: str) -> str:
    return f"""<system name="{name}" ir_version="0.1">
  <metadata><title>{name}</title><description>d</description><author>AIR</author><created_at>2026-01-01T00:00:00Z</created_at></metadata>
  <nets>
    <net id="v3v3" role="power" nominal_voltage="3.3V"/><net id="gnd" role="ground"/>
    <net id="sense" role="analog_signal"/><net id="act" role="digital_signal"/>
  </nets>
  <components>
    <component id="U_MCU" type="mcu" part="STM32F103">
      <pin name="VDD" net="v3v3"/><pin name="VSS" net="gnd"/>
      <pin name="PA0" net="sense" function="ADC1_CH0"/><pin name="PA1" net="act" function="GPIO"/>
    </component>
    <component id="R_TOP" type="resistor"><value>10k</value><pin name="1" net="v3v3"/><pin name="2" net="sense"/></component>
    <component id="R_BOT" type="resistor"><value>10k</value><pin name="1" net="sense"/><pin name="2" net="gnd"/></component>
    <component id="Q_ACT" type="mosfet" spice_model="NMOS"><pin name="G" net="act"/><pin name="D" net="v3v3"/><pin name="S" net="gnd"/></component>
  </components>
  <tests><test id="t"><setup><set_voltage net="v3v3" value="3.3V"/></setup><run duration="1ms"/><assert_voltage net="sense" min="0V" max="3.3V"/></test></tests>
  <simulation_profiles><profile id="analog_only" default="true"><backend type="ngspice"/><run test="t"/></profile></simulation_profiles>
</system>"""


@dataclass
class Phase:
    label: str
    counts: int
    hold_ms: int


@dataclass
class App:
    name: str
    spec: str
    phases: list[Phase]
    assert_fn: Callable[[dict[str, dict[str, int]]], tuple[bool, str]]
    design: str = ""

    def __post_init__(self):
        self.design = stm32_sense_design(self.name)


def parse_kv(line: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for k, v in re.findall(r"([A-Z_]+)=(-?\d+)", line):
        out[k] = int(v)
    return out


def settled_per_phase(uart: str, phases: list[Phase]) -> dict[str, dict[str, int]]:
    """Last COMPLETE telemetry line whose echoed ADC matches each phase's counts.

    The UART file backend can truncate the final line mid-print, so we take the
    last line that has the full field count (max keys seen for that phase), not
    literally the last line.
    """
    rows = [parse_kv(l) for l in uart.splitlines() if "ADC=" in l]
    result: dict[str, dict[str, int]] = {}
    for ph in phases:
        matching = [r for r in rows if r.get("ADC") == ph.counts]
        if not matching:
            continue
        max_keys = max(len(r) for r in matching)
        complete = [r for r in matching if len(r) == max_keys]
        result[ph.label] = complete[-1]
    return result


def author_build(app: App) -> Path | None:
    work = WORK / app.name
    elf = work / "fw" / "build" / "firmware" / ".pio" / "build" / "bluepill_f103c8" / "firmware.elf"
    import os
    if elf.exists() and os.environ.get("AIR_TANDEM_REBUILD") != "1":
        print(f"  [{app.name}] reusing cached firmware")
        return elf
    work.mkdir(parents=True, exist_ok=True)
    ok, diags = validate_design_xml(app.design)
    if not ok:
        print(f"  [{app.name}] design INVALID: {[d['code'] for d in diags if d.get('severity')=='error']}")
        return None
    (work / "design.air.xml").write_text(app.design, encoding="utf-8")
    fw = run_ai_firmware(work / "design.air.xml", IO_PREAMBLE + app.spec, work / "fw", provider="gemini")
    elf = work / "fw" / "build" / "firmware" / ".pio" / "build" / "bluepill_f103c8" / "firmware.elf"
    print(f"  [{app.name}] firmware compiled={fw.get('compiled')} iters={fw.get('iterations')}")
    return elf if fw.get("compiled") and elf.exists() else None


def run_stimulus(app: App, elf: Path) -> str:
    out = WORK / app.name / "renode"
    out.mkdir(parents=True, exist_ok=True)
    cap = (out / "uart.log").as_posix()
    lines = [
        "*** Settings ***", "Suite Setup       Setup", "Suite Teardown    Teardown",
        "Resource          ${RENODEKEYWORDS}", "", "*** Test Cases ***", "Run",
        "    Execute Command    mach create",
        "    Execute Command    machine LoadPlatformDescription @platforms/cpus/stm32f103.repl",
        f"    Execute Command    machine LoadPlatformDescription @{PERIPH.as_posix()}",
        f"    Execute Command    sysbus LoadELF @{elf.as_posix()}",
        f"    Execute Command    sysbus.usart1 CreateFileBackend @{cap}",
        f"    Execute Command    sysbus.adc1 WriteDoubleWord 0x100 {app.phases[0].counts}",
        "    Execute Command    start",
    ]
    for ph in app.phases:
        lines.append(f"    Execute Command    sysbus.adc1 WriteDoubleWord 0x100 {ph.counts}")
        lines.append(f"    Sleep              {ph.hold_ms}ms")
    lines.append("    Execute Command    pause")
    robot = out / "run.robot"
    robot.write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run([RENODE_TEST, str(robot)], capture_output=True, text=True, cwd=ROOT)
    return (out / "uart.log").read_text(encoding="utf-8") if (out / "uart.log").exists() else ""


# --------------------------------------------------------------------------- #
# The 4 products
# --------------------------------------------------------------------------- #
def _fuel_gauge_assert(r):
    need = {"full", "empty", "band"}
    if not need <= r.keys():
        return False, f"missing phases {need - r.keys()}"
    soc_ok = r["full"].get("SOC", 0) > r["empty"].get("SOC", 0)
    latch_ok = r["empty"].get("LOW") == 1 and r["band"].get("LOW") == 1
    return (soc_ok and latch_ok), (f"SOC full={r['full'].get('SOC')} empty={r['empty'].get('SOC')}; "
                                   f"LOW empty={r['empty'].get('LOW')} band(latched)={r['band'].get('LOW')}")


def _motor_assert(r):
    if not {"slow", "fast"} <= r.keys():
        return False, "missing phases"
    d_slow, d_fast = r["slow"].get("DUTY", 0), r["fast"].get("DUTY", 0)
    return (d_slow > d_fast), f"DUTY slow-feedback={d_slow} > fast-feedback={d_fast} (PI speeds up when slow)"


def _supervisor_assert(r):
    if not {"normal", "fault", "recover"} <= r.keys():
        return False, "missing phases"
    ok = (r["normal"].get("STATE") == 0 and r["fault"].get("STATE") == 1 and r["recover"].get("STATE") == 0)
    return ok, (f"STATE normal={r['normal'].get('STATE')} fault(debounced)={r['fault'].get('STATE')} "
                f"recover={r['recover'].get('STATE')}")


def _dsp_assert(r):
    if not {"low", "high", "band", "low2"} <= r.keys():
        return False, "missing phases"
    out_ok = (r["low"].get("OUT") == 0 and r["high"].get("OUT") == 1
              and r["band"].get("OUT") == 1 and r["low2"].get("OUT") == 0)
    track_ok = r["high"].get("FILT", 0) > r["low"].get("FILT", 0)
    return (out_ok and track_ok), (f"OUT low={r['low'].get('OUT')} high={r['high'].get('OUT')} "
                                   f"band(hyst)={r['band'].get('OUT')} low2={r['low2'].get('OUT')}; "
                                   f"FILT tracks {r['low'].get('FILT')}->{r['high'].get('FILT')}")


APPS = [
    App(
        name="fuel_gauge",
        spec=(
            "Battery fuel gauge. Treat `adc` as a battery-sense reading through a 2:1 divider with a "
            "3.3V reference: battery_mv = adc * 3300 / 4095 * 2. Estimate state-of-charge SOC (0..100) "
            "from a LiPo open-circuit-voltage curve (3000 mV -> 0%, 4200 mV -> 100%, smooth in between) "
            "fused with coulomb counting (integrate a small assumed load current over millis), smoothed "
            "by an exponential moving average. Maintain a LATCHED low-battery flag LOW: set LOW=1 when "
            "battery_mv < 3300, and clear to 0 ONLY when battery_mv rises above 3600 (hysteresis). "
            "Print: `ADC=<adc> MV=<battery_mv> SOC=<soc> LOW=<0|1>`."
        ),
        phases=[Phase("full", 2480, 1200), Phase("empty", 1800, 1500), Phase("band", 2100, 1500)],
        assert_fn=_fuel_gauge_assert,
    ),
    App(
        name="motor_pi",
        spec=(
            "Closed-loop motor speed controller. Treat `adc` as a tachometer feedback voltage where "
            "rpm = adc * 2 (so higher adc = faster). Run a PI controller (proportional + integral with "
            "anti-windup clamping) toward a setpoint of 4000 rpm, producing a motor PWM duty 0..255 "
            "(you may analogWrite(PA1, duty)). When measured rpm is below setpoint, duty must rise; "
            "above setpoint, duty must fall. Print: `ADC=<adc> RPM=<rpm> DUTY=<duty>`."
        ),
        phases=[Phase("slow", 500, 1500), Phase("fast", 3500, 1500)],
        assert_fn=_motor_assert,
    ),
    App(
        name="supervisor",
        spec=(
            "Power-rail over/under-voltage supervisor with debounce. Treat `adc` as a 5V rail sensed "
            "through a 2:1 divider, 3.3V ref: rail_mv = adc * 3300 / 4095 * 2. NORMAL window is "
            "4500..5500 mV. Use a state machine with debounce: only enter FAULT after the reading has "
            "been OUTSIDE the window for at least 5 consecutive samples; only return to NORMAL after it "
            "has been INSIDE the window for at least 5 consecutive samples. Print STATE as 0 for NORMAL "
            "and 1 for FAULT. Print: `ADC=<adc> MV=<rail_mv> STATE=<0|1>`."
        ),
        phases=[Phase("normal", 3100, 1200), Phase("fault", 2200, 1800), Phase("recover", 3050, 1800)],
        assert_fn=_supervisor_assert,
    ),
    App(
        name="dsp_filter",
        spec=(
            "Glitch-rejecting threshold detector. Maintain a median-of-5 sliding window over `adc` "
            "followed by an exponential moving average (alpha ~0.2) to produce FILT. Apply a "
            "Schmitt-trigger: OUT becomes 1 when FILT rises above 2500, and returns to 0 only when "
            "FILT falls below 1500 (hysteresis band 1500..2500 holds the previous OUT). "
            "Print: `ADC=<adc> FILT=<filt> OUT=<0|1>`."
        ),
        phases=[Phase("low", 800, 1200), Phase("high", 3500, 1800),
                Phase("band", 2000, 1500), Phase("low2", 800, 1500)],
        assert_fn=_dsp_assert,
    ),
]


def main() -> int:
    print("=== 4 non-trivial products through PlatformIO + Renode tandem ===")
    passed = 0
    for app in APPS:
        elf = author_build(app)
        if not elf:
            print(f"[FAIL] {app.name}: firmware did not compile")
            continue
        uart = run_stimulus(app, elf)
        readings = settled_per_phase(uart, app.phases)
        ok, detail = app.assert_fn(readings)
        passed += 1 if ok else 0
        print(f"[{'OK ' if ok else 'FAIL'}] {app.name:14} {detail}")
        if not ok and not readings:
            print(f"        (no telemetry parsed; uart sample: {uart.strip().splitlines()[-1:]})")
    print(f"\nProducts passed: {passed}/{len(APPS)}")
    return 0 if passed == len(APPS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
