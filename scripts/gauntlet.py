"""Live agent+engine reliability gauntlet. Run: python scripts/gauntlet.py"""
from __future__ import annotations

import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from air.agent import run_ai_generate, run_autonomous_repair  # noqa: E402
from air.service import save_design, simulate_design, validate_design  # noqa: E402


def gen_and_check(name: str, prompt: str, simulate: bool = True) -> bool:
    out = ROOT / f"generated/gauntlet/{name}.air.xml"
    gen = run_ai_generate(prompt, out, provider="gemini")
    line = f"[{name}] valid={gen.get('valid')} attempts={gen.get('attempts')}"
    if not gen.get("valid"):
        errs = [d["code"] for d in gen.get("diagnostics", []) if d.get("severity") == "error"]
        print(line + f" ERRORS={errs[:6]}")
        return False
    if simulate:
        saved = save_design(out.read_text(encoding="utf-8"), out)
        sim = simulate_design(out, saved["profile"], ROOT / f"generated/gauntlet/{name}_run")
        rep = sim["reports"][0] if sim.get("reports") else {}
        line += f" | SIM={sim['status']} backend={rep.get('backend')} meas={rep.get('measurements')}"
    print(line)
    return True


PROMPTS = {
    "p1": ("A resistor voltage divider: a 5V DC source feeds two equal 10k resistors in series to "
           "ground. Probe the midpoint and assert it is about 2.5V (min 2.4V max 2.6V).", True),
    "p2": ("An ESP32-C3 battery monitor: a 3.7V battery on net v_bat feeds an LDO that outputs 3.3V. "
           "A resistor divider from v_bat to a battery_sense net feeds an ADC-capable GPIO, kept under "
           "3.3V at 4.2V. Probe battery_sense; a firmware task reads the ADC every 60s.", False),
    "p3": ("An ESP32-C3 node with an I2C temperature sensor on the 3.3V rail, including SDA and SCL "
           "pull-up resistors to 3.3V. Power the MCU from a 3.3V rail and ground.", False),
    "p4": ("An ESP32-C3 drives an NMOS MOSFET low-side switch (gate from a GPIO_OUT pin) to switch a "
           "100mA load on a 5V rail. Add a firmware task that toggles the gate. Probe the load node.", False),
}


def main() -> None:
    print("=== GAUNTLET (contract attached) ===")
    for name, (prompt, sim) in PROMPTS.items():
        try:
            gen_and_check(name, prompt, simulate=sim)
        except Exception as exc:  # noqa: BLE001
            print(f"[{name}] EXCEPTION: {exc}")

    fixture = ROOT / "examples/failing/overloaded_3v3_rail.air.xml"
    if fixture.exists():
        pre = validate_design(fixture)
        codes = [d["code"] for d in pre["diagnostics"] if d.get("severity") == "error"]
        print(f"[p5] fixture pre-repair errors: {codes[:4]}")
        res = run_autonomous_repair(fixture, ROOT / "generated/gauntlet/p5_auto", max_iterations=3, provider="gemini")
        print(f"[p5] autonomous_repair success={res['success']} msg={res['message'][:90]}")
    else:
        print("[p5] fixture missing")


if __name__ == "__main__":
    main()
