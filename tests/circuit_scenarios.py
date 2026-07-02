"""20 non-trivial circuit scenarios + a runner for the multi-step agent E2E.

Each scenario is a sequence of steps: a `draw` (generate from scratch), then
`minor` and `major` tweaks (edit the running design). The durable invariants we
assert at every step are (1) the produced design VALIDATES and (2) it SIMULATES
when analog; numeric checks are attached only to `draw` steps where the prompt
pins the exact source, resistor values, and output net name so the expected node
voltage is deterministic regardless of the model's other choices.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air.agent import run_ai_edit, run_ai_generate, validate_design_xml  # noqa: E402
from air.service import save_design, simulate_design  # noqa: E402
from air.units import parse_quantity  # noqa: E402


@dataclass
class Step:
    kind: str                                   # "draw" | "minor" | "major"
    instruction: str
    simulate: bool = False
    expect: tuple[str, float, float] | None = None  # (net, min_v, max_v) checked in measurements


@dataclass
class Scenario:
    name: str
    steps: list[Step] = field(default_factory=list)


def _draw(instruction: str, simulate: bool = True, expect=None) -> Step:
    return Step("draw", instruction, simulate=simulate, expect=expect)


def _minor(instruction: str, simulate: bool = False) -> Step:
    return Step("minor", instruction, simulate=simulate)


def _major(instruction: str, simulate: bool = True) -> Step:
    return Step("major", instruction, simulate=simulate)


# --------------------------------------------------------------------------- #
# Step execution
# --------------------------------------------------------------------------- #
@dataclass
class StepResult:
    kind: str
    instruction: str
    valid: bool
    error_codes: list[str]
    attempts: int
    sim_status: str | None
    numeric_ok: bool | None
    detail: str = ""

    @property
    def ok(self) -> bool:
        # Hard invariants: every step must validate; analog steps must simulate
        # (status present and not an error string); numeric checks must hold.
        if not self.valid:
            return False
        if self.sim_status is not None and self.sim_status not in {"passed", "failed"}:
            return False
        if self.numeric_ok is False:
            return False
        return True


def _run_step(step: Step, current_xml: str | None, out: Path, provider: str, model: str | None,
              check_numeric: bool) -> tuple[StepResult, str]:
    # A single step must never crash the whole run: any unexpected error
    # (transient API failure, etc.) becomes a failed StepResult.
    try:
        if step.kind == "draw" or current_xml is None:
            gen = run_ai_generate(step.instruction, out, provider=provider, model=model)
        else:
            gen = run_ai_edit(current_xml, step.instruction, out, provider=provider, model=model)
    except Exception as exc:  # noqa: BLE001
        return (StepResult(step.kind, step.instruction, False, ["STEP_EXCEPTION"], 0, None, None,
                           detail=str(exc)), current_xml or "")

    if not gen.get("success"):
        return (StepResult(step.kind, step.instruction, False, ["GENERATION_FAILED"], 0, None, None,
                           detail=str(gen.get("error", ""))), current_xml or "")

    design_xml = out.read_text(encoding="utf-8")
    valid = bool(gen.get("valid"))
    codes = [d.get("code") for d in gen.get("diagnostics", []) if d.get("severity") == "error"]

    sim_status: str | None = None
    numeric_ok: bool | None = None
    detail = ""
    if valid and step.simulate:
        try:
            saved = save_design(design_xml, out)
            sim = simulate_design(out, saved["profile"], out.parent / f"{out.stem}_run")
            sim_status = sim.get("status")
            measurements: dict[str, str] = {}
            for report in sim.get("reports", []):
                measurements.update(report.get("measurements", {}))
            if not sim.get("reports"):
                sim_status = sim_status or "no_reports"
            if check_numeric and step.expect:
                net, lo, hi = step.expect
                # Match the net tolerantly: the model may pick 'v_mid' for 'vmid'.
                def _norm(name: str) -> str:
                    return "".join(ch for ch in name.lower() if ch.isalnum())
                raw = measurements.get(net)
                if raw is None:
                    target = _norm(net)
                    raw = next((v for k, v in measurements.items() if _norm(k) == target), None)
                if raw is None:
                    numeric_ok = False
                    detail = f"net '{net}' not in measurements {list(measurements)}"
                else:
                    val = parse_quantity(raw, "V")
                    numeric_ok = lo <= val <= hi
                    detail = f"{net}={raw} (want {lo}..{hi})"
        except Exception as exc:  # noqa: BLE001
            sim_status = f"error:{exc}"

    return (StepResult(step.kind, step.instruction, valid, codes, int(gen.get("attempts", 0)),
                       sim_status, numeric_ok, detail), design_xml)


def run_scenario(scenario: Scenario, work_dir: Path, provider: str = "gemini", model: str | None = None,
                 check_numeric: bool = True) -> list[StepResult]:
    work_dir.mkdir(parents=True, exist_ok=True)
    results: list[StepResult] = []
    current_xml: str | None = None
    for index, step in enumerate(scenario.steps):
        out = work_dir / f"{scenario.name}_{index}_{step.kind}.air.xml"
        result, current_xml = _run_step(step, current_xml, out, provider, model, check_numeric)
        results.append(result)
    return results


# --------------------------------------------------------------------------- #
# The 20 scenarios
# --------------------------------------------------------------------------- #
SCENARIOS: list[Scenario] = [
    Scenario("divider_5v", [
        _draw("A voltage divider: a 5V DC source feeds two equal 10k resistors in series to ground. "
              "Name the midpoint net 'vout' and add a test asserting vout is 2.4V to 2.6V.",
              expect=("vout", 2.4, 2.6)),
        _minor("Change the DC source from 5V to 10V."),
        _minor("Change both resistors to 4.7k."),
        _major("Add a 1uF decoupling capacitor from vout to ground."),
        _major("Add a second divider stage off vout producing a new net 'vout2' at half of vout."),
    ]),
    Scenario("divider_12v", [
        _draw("A divider from a 12V DC source: top resistor 10k, bottom resistor 3k3 to ground. "
              "Name the tap net 'vsense' and assert vsense is between 2.6V and 3.2V.",
              expect=("vsense", 2.6, 3.2)),
        _minor("Increase the top resistor to 22k."),
        _minor("Add a probe on vsense."),
        _major("Add an LDO regulating 12V down to a 5V rail named 'v5'."),
        _major("Add a 100mA load on the v5 rail and size the regulator above the load."),
    ]),
    Scenario("ldo_5_to_3v3", [
        _draw("An LDO regulator converting a 5V input rail 'vin' to a 3.3V output rail 'v3v3'. "
              "Include a test asserting v3v3 is between 3.0V and 3.6V.", expect=("v3v3", 3.0, 3.6)),
        _minor("Set the LDO quiescent current to 50uA."),
        _minor("Rename the output rail from v3v3 to vcc3."),
        _major("Add a 200mA load on the 3.3V rail."),
        _major("Add a second LDO producing a 1.8V rail 'v1v8' from the 5V input."),
    ]),
    Scenario("battery_adc", [
        _draw("An ESP32-C3 battery monitor: a 3.7V battery on net 'v_bat' feeds an LDO that outputs "
              "3.3V. A resistor divider from v_bat to a 'battery_sense' net feeds an ADC-capable GPIO, "
              "kept under 3.3V at full charge. Probe battery_sense."),
        _minor("Change the battery nominal voltage to 4.2V."),
        _minor("Add a firmware task that reads the ADC every 30 seconds."),
        _major("Add a power-on indicator LED with a series resistor on the 3.3V rail."),
        _major("Add an I2C temperature sensor on the 3.3V rail with SDA and SCL pull-ups."),
    ]),
    Scenario("i2c_node", [
        _draw("An ESP32-C3 powered from a 3.3V rail and ground, with an I2C temperature sensor and "
              "4.7k SDA and SCL pull-up resistors to 3.3V."),
        _minor("Change the pull-up resistors to 2.2k."),
        _minor("Add a second I2C device address note in the metadata description."),
        _major("Add an LDO so the 3.3V rail is regulated from a 5V input."),
        _major("Add a MOSFET low-side switch driven by a GPIO to control a 100mA load."),
    ]),
    Scenario("mosfet_switch", [
        _draw("An ESP32-C3 drives an NMOS MOSFET low-side switch whose gate comes from a GPIO_OUT pin, "
              "switching a 100mA load on a 5V rail. Add a firmware task that toggles the gate."),
        _minor("Increase the switched load to 250mA."),
        _minor("Add a flyback diode across the load."),
        _major("Add a current-sense resistor in series with the load."),
        _major("Add a second independently switched load on another GPIO."),
    ]),
    Scenario("rc_filter", [
        _draw("A 5V source 'vin' through a 10k resistor into a node 'vmid', with a 1uF capacitor from "
              "vmid to ground. Assert vmid settles between 4.9V and 5.1V.", expect=("vmid", 4.8, 5.1)),
        _minor("Change the capacitor to 10uF."),
        _minor("Change the resistor to 1k."),
        _major("Add a second RC stage producing node 'vout2'."),
        _major("Drive vin from an LDO-regulated 5V rail instead of a bare source."),
    ]),
    Scenario("dual_rail", [
        _draw("A system with a 5V input that feeds two LDOs: one producing a 3.3V rail 'v3v3' and one "
              "producing a 1.8V rail 'v1v8'. Assert v3v3 is 3.0V to 3.6V.", expect=("v3v3", 3.0, 3.6)),
        _minor("Add a 50mA load on the 1.8V rail."),
        _minor("Add a 100mA load on the 3.3V rail."),
        _major("Add an ESP32-C3 powered from the 3.3V rail."),
        _major("Add a battery-sense divider from the 5V input to an ADC pin."),
    ]),
    Scenario("ladder_divider", [
        _draw("A three-resistor ladder from a 9V source: 10k, 10k, 10k in series to ground, with taps "
              "'t1' (after the first resistor) and 't2' (after the second). Assert t1 is 5.5V to 6.5V.",
              expect=("t1", 5.5, 6.5)),
        _minor("Change the source to 6V."),
        _minor("Add a probe on t2."),
        _major("Add a buffer load of 1mA on t1 via a generic load."),
        _major("Add an LDO regulating the 9V source down to a 5V rail."),
    ]),
    Scenario("current_limited_rail", [
        _draw("A 3.7V battery feeds an LDO rated 250mA producing a 3.3V rail powering a 150mA load. "
              "Assert the 3.3V rail is between 3.0V and 3.6V.", expect=None),
        _minor("Increase the load to 200mA."),
        _minor("Add a probe on the 3.3V rail."),
        _major("Add a second 100mA load on the same rail."),
        _major("Upgrade the regulator so it comfortably supplies the total load."),
    ]),
    Scenario("sensor_node_full", [
        _draw("A complete ESP32-C3 sensor node: 3.7V battery, an LDO to 3.3V, an I2C sensor with "
              "pull-ups, a battery-sense divider to an ADC pin, and a firmware task reading both."),
        _minor("Change the ADC sampling period to 10 seconds."),
        _minor("Add a status LED with series resistor."),
        _major("Add a MOSFET-switched buzzer load controlled by a GPIO."),
        _major("Add a second voltage rail at 1.8V for the sensor's core."),
    ]),
    Scenario("led_series", [
        _draw("An LED with a series current-limiting resistor from a 5V rail 'v5' to ground."),
        _minor("Change the series resistor to 330 ohm."),
        _minor("Add a second LED in parallel with its own series resistor."),
        _major("Drive the LEDs from an LDO-regulated 5V rail."),
        _major("Add a GPIO-driven MOSFET to switch the LEDs."),
    ]),
    Scenario("voltage_reference", [
        _draw("A 5V source feeding a divider that produces a 1.65V reference net 'vref' (half of 3.3V "
              "is not needed; use 5V and pick resistors for ~1.65V). Assert vref is 1.5V to 1.8V.",
              expect=("vref", 1.5, 1.8)),
        _minor("Tighten the assertion to 1.6V-1.7V."),
        _minor("Add a 100nF capacitor from vref to ground."),
        _major("Buffer vref to two ADC channels of an ESP32-C3."),
        _major("Regulate the 5V source with an LDO from a 9V input."),
    ]),
    Scenario("pullup_network", [
        _draw("An ESP32-C3 on a 3.3V rail with a GPIO input that has a 10k pull-up resistor to 3.3V."),
        _minor("Change the pull-up to 4.7k."),
        _minor("Add a second GPIO input with a 10k pull-down to ground."),
        _major("Add an LDO regulating the 3.3V rail from 5V."),
        _major("Add an I2C bus with pull-ups to the same MCU."),
    ]),
    Scenario("battery_buck_mcu", [
        _draw("A 3.7V battery powering an ESP32-C3 directly on a 3v3-equivalent rail, with a "
              "battery-sense divider 'vbatt_sense' to an ADC pin kept under the ADC reference."),
        _minor("Change the divider ratio so the sense voltage is lower."),
        _minor("Add a probe on vbatt_sense."),
        _major("Insert an LDO between the battery and the MCU producing a clean 3.3V rail."),
        _major("Add a firmware task logging the battery voltage every minute."),
    ]),
    Scenario("two_stage_divider", [
        _draw("A 10V source into a divider producing 'mid' at 5V (two equal resistors), then a second "
              "divider off 'mid' producing 'low' at 2.5V. Assert mid is 4.8V to 5.2V.",
              expect=("mid", 4.8, 5.2)),
        _minor("Change the source to 8V."),
        _minor("Add probes on mid and low."),
        _major("Add an ESP32-C3 reading 'low' on an ADC pin."),
        _major("Add an LDO regulating the 10V source to a 5V rail feeding the dividers."),
    ]),
    Scenario("load_step_rail", [
        _draw("A 5V LDO rail 'v5' powering a generic load that steps from 50mA to 150mA during the "
              "test. Assert v5 stays between 4.8V and 5.2V."),
        _minor("Change the step to go from 100mA to 300mA."),
        _minor("Add a probe on v5."),
        _major("Add a bulk capacitor from v5 to ground."),
        _major("Add a second always-on 100mA load on v5."),
    ]),
    Scenario("esp32_adc_chain", [
        _draw("An ESP32-C3 with a divider from a 5V rail to an ADC pin (net 'adc_in') kept under 3.3V, "
              "and a firmware task reading the ADC."),
        _minor("Change the ADC reading period to 5 seconds."),
        _minor("Add a probe on adc_in."),
        _major("Add an LDO so the 5V rail is regulated from a 9V input."),
        _major("Add an I2C sensor with pull-ups to the same MCU."),
    ]),
    Scenario("stm32_node", [
        _draw("An STM32F103 powered from a 3.3V rail and ground, with a divider from 5V to one of its "
              "ADC pins (kept under 3.3V)."),
        _minor("Add a probe on the ADC sense net."),
        _minor("Change the divider so the sense voltage is around 1.5V."),
        _major("Add an LDO regulating the 3.3V rail from a 5V input."),
        _major("Add a GPIO-driven MOSFET switching a 100mA load."),
    ]),
    Scenario("regulated_sensor_chain", [
        _draw("A 9V supply, an LDO to 5V, a second LDO from 5V to 3.3V, and an ESP32-C3 on the 3.3V "
              "rail. Assert the 3.3V rail is 3.0V to 3.6V.", expect=None),
        _minor("Add a 100mA load on the 5V rail."),
        _minor("Add a battery-sense divider from 9V to an ADC pin."),
        _major("Add an I2C sensor on the 3.3V rail with pull-ups."),
        _major("Add a MOSFET-switched load on the 5V rail driven by a GPIO."),
    ]),
]

assert len(SCENARIOS) == 20, f"expected 20 scenarios, got {len(SCENARIOS)}"
