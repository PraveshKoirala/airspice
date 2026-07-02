"""5 professional-grade product scenarios for the full design->firmware->binary loop.

Each is a real product a professional might iterate on for ~a month: a non-trivial
hardware design AND sophisticated control firmware (SoC estimation, PID, MPPT, a
soft-start state machine, a scheduled logger). The runner asks the agent to design
the hardware (valid AIR), then author bespoke C++ for the functional spec and
compile it against the real toolchain, feeding compiler errors back until it builds.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air.agent import run_ai_firmware, run_ai_generate  # noqa: E402
from air.service import save_design, simulate_design  # noqa: E402


@dataclass
class Product:
    name: str
    hardware_prompt: str
    firmware_spec: str
    must_contain: list[str]          # hardware-I/O primitives the firmware must use
    min_chars: int = 700             # "sophisticated, not a stub"


@dataclass
class ProductResult:
    name: str
    design_valid: bool
    sim_status: str | None
    compiled: bool
    compile_attempted: bool
    iterations: int
    missing_primitives: list[str] = field(default_factory=list)
    too_short: bool = False
    detail: str = ""

    @property
    def ok(self) -> bool:
        return (
            self.design_valid
            and self.compiled
            and not self.missing_primitives
            and not self.too_short
        )


PRODUCTS: list[Product] = [
    Product(
        name="lipo_fuel_gauge",
        hardware_prompt=(
            "An ESP32-C3 smart LiPo battery fuel gauge. A single-cell LiPo (net v_bat, 3.0-4.2V) "
            "feeds a resistor divider to an ADC-capable GPIO (kept under 3.3V), and an NMOS "
            "low-side MOSFET (gate from a GPIO_OUT pin) can disconnect the load. Power the MCU "
            "from a regulated 3.3V rail via an LDO from the battery."
        ),
        firmware_spec=(
            "Implement a battery fuel gauge. Sample the battery voltage via the ADC divider, "
            "convert ADC counts to battery millivolts accounting for the divider ratio and 3.3V "
            "reference. Fuse a voltage-based state-of-charge lookup (a LiPo discharge curve) with "
            "coulomb counting (integrate an estimated load current over elapsed millis()) to "
            "estimate state-of-charge in percent, smoothed with an exponential moving average. "
            "If the battery drops below a low-voltage threshold, open the load MOSFET (cutoff) with "
            "hysteresis so it only reconnects above a higher threshold. Print SoC, mV, and load "
            "state over Serial once per second."
        ),
        must_contain=["analogRead", "digitalWrite", "millis"],
    ),
    Product(
        name="pid_heater_controller",
        hardware_prompt=(
            "An ESP32-C3 closed-loop heater controller. A thermistor divider connects to an "
            "ADC-capable GPIO, and a heater is driven through an NMOS MOSFET whose gate is a "
            "GPIO_OUT pin (PWM). Power from a 5V rail; include the thermistor pull resistor."
        ),
        firmware_spec=(
            "Implement a PID temperature controller. Read the thermistor via the ADC and convert "
            "to temperature in Celsius (Steinhart-Hart or a beta approximation). Run a PID loop at "
            "a fixed interval using millis(): proportional, integral (with anti-windup clamping), "
            "and derivative-on-measurement terms, with tunable Kp/Ki/Kd constants and a setpoint. "
            "Drive the heater MOSFET with analogWrite PWM from the clamped PID output (0-255). Add "
            "an over-temperature safety cutoff that forces PWM to 0. Print setpoint, temperature, "
            "and PWM duty over Serial."
        ),
        must_contain=["analogRead", "analogWrite", "millis"],
    ),
    Product(
        name="env_data_logger",
        hardware_prompt=(
            "An ESP32-C3 environmental data logger powered from a 3.3V LDO rail, with an I2C "
            "temperature/humidity sensor (SDA and SCL with pull-ups to 3.3V) and a battery-sense "
            "resistor divider to an ADC-capable GPIO."
        ),
        firmware_spec=(
            "Implement a scheduled environmental logger. Using millis() as a scheduler, sample the "
            "battery voltage via the ADC every fixed interval. Maintain a fixed-size circular "
            "buffer of the last N samples and compute running minimum, maximum, and mean across "
            "the buffer. Every M samples, emit a CSV line over Serial with timestamp, latest "
            "value, min, max, and mean. Keep the main loop non-blocking (no long delay())."
        ),
        must_contain=["analogRead", "millis", "Serial.print"],
    ),
    Product(
        name="motor_soft_start",
        hardware_prompt=(
            "An ESP32-C3 DC motor controller. A brushed DC motor load is switched by an NMOS "
            "MOSFET driven (PWM) from a GPIO_OUT pin on a 12V rail, with a low-side current-sense "
            "resistor feeding an ADC-capable GPIO via a divider kept under 3.3V."
        ),
        firmware_spec=(
            "Implement a motor soft-start with current limiting as a state machine (IDLE, "
            "SOFT_START, RUN, FAULT). On start, ramp the PWM duty from 0 to target over a "
            "configurable ramp time using millis(). Continuously read the current-sense ADC; if "
            "current exceeds a limit, fold back the PWM duty, and if it persists, latch into FAULT "
            "and disable the motor. Recover from FAULT only after a cooldown. Drive PWM with "
            "analogWrite. Print the state, duty, and sensed current over Serial."
        ),
        must_contain=["analogRead", "analogWrite", "millis"],
    ),
    Product(
        name="solar_mppt_charger",
        hardware_prompt=(
            "An ESP32-C3 solar charge controller. A solar panel voltage and a battery voltage are "
            "each sensed through resistor dividers to two ADC-capable GPIOs (kept under 3.3V). A "
            "charge path is switched by an NMOS MOSFET driven (PWM) from a GPIO_OUT pin. Power the "
            "MCU from a 3.3V LDO rail."
        ),
        firmware_spec=(
            "Implement a solar MPPT charge controller. Read panel and battery voltages via the two "
            "ADC dividers. Run a perturb-and-observe MPPT: periodically (millis-paced) adjust the "
            "PWM duty and compare computed input power to track the maximum power point. Layer a "
            "three-stage charge state machine on top (BULK, ABSORB, FLOAT) selected by battery "
            "voltage thresholds, and enforce an over-voltage cutoff that forces duty to 0 if the "
            "battery exceeds a hard limit. Drive PWM with analogWrite and print stage, duties, and "
            "voltages over Serial."
        ),
        must_contain=["analogRead", "analogWrite", "millis"],
    ),
]

assert len(PRODUCTS) == 5


def run_product(product: Product, work_dir: Path, provider: str = "gemini", model: str | None = None) -> ProductResult:
    work_dir.mkdir(parents=True, exist_ok=True)
    design_path = work_dir / "design.air.xml"

    gen = run_ai_generate(product.hardware_prompt, design_path, provider=provider, model=model)
    design_valid = bool(gen.get("valid"))

    sim_status = None
    if design_valid:
        try:
            saved = save_design(design_path.read_text(encoding="utf-8"), design_path)
            sim = simulate_design(design_path, saved["profile"], work_dir / "sim")
            sim_status = sim.get("status")
        except Exception as exc:  # noqa: BLE001
            sim_status = f"error:{exc}"

    fw = run_ai_firmware(design_path, product.firmware_spec, work_dir / "fw", provider=provider, model=model)
    code = ""
    code_path = fw.get("code_path")
    if code_path and Path(code_path).exists():
        code = Path(code_path).read_text(encoding="utf-8")
    lower = code.lower()
    missing = [p for p in product.must_contain if p.lower() not in lower]

    return ProductResult(
        name=product.name,
        design_valid=design_valid,
        sim_status=sim_status,
        compiled=bool(fw.get("compiled")),
        compile_attempted=bool(fw.get("compile_attempted")),
        iterations=int(fw.get("iterations", 0)),
        missing_primitives=missing,
        too_short=len(code) < product.min_chars,
        detail=str(fw.get("log_tail", ""))[-400:],
    )
