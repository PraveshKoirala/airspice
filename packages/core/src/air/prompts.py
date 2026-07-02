"""Centralized prompts, model defaults, and the authoritative AIR authoring
contract attached to *every* agent request.

The contract is generated from the live registry (`COMPONENT_SPECS`, `MCUS`) so
it can never drift from what the validator enforces: if a component's required
pins or properties change, the text the model sees changes with it. Attaching the
full contract to every generate/repair/chat call is the primary defense against
schema errors; the normalizer coercions and self-verifying parser are secondary.
"""

from __future__ import annotations

import json
from functools import lru_cache

# Real, currently-served model ids (verified via genai.list_models()).
# Override per-deployment with AIR_GEMINI_MODEL / AIR_OPENAI_MODEL.
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"


# A complete design that passes validate_ir - the canonical few-shot pattern.
GOLDEN_DESIGN = """<system name="example_regulator" ir_version="0.1">
  <metadata>
    <title>3V3 Regulated Rail</title>
    <description>LDO from a 5V input feeding a sensing divider.</description>
    <author>AIR</author>
    <created_at>2026-01-01T00:00:00Z</created_at>
  </metadata>
  <nets>
    <net id="v_in" role="power" nominal_voltage="5V"/>
    <net id="v_3v3" role="power" nominal_voltage="3.3V"/>
    <net id="sense" role="analog_signal"/>
    <net id="gnd" role="ground"/>
  </nets>
  <components>
    <component id="V_IN" type="voltage_source"><value>5V</value>
      <pin name="p" net="v_in"/><pin name="n" net="gnd"/></component>
    <component id="U_REG" type="ldo" part="LM1117">
      <pin name="in" net="v_in"/><pin name="out" net="v_3v3"/><pin name="gnd" net="gnd"/>
      <property name="vout" value="3.3V"/><property name="iout_max" value="800mA"/>
      <property name="v_dropout" value="1.2V"/><property name="iq" value="5mA"/>
    </component>
    <component id="R_TOP" type="resistor"><value>10k</value>
      <pin name="1" net="v_3v3"/><pin name="2" net="sense"/></component>
    <component id="R_BOT" type="resistor"><value>10k</value>
      <pin name="1" net="sense"/><pin name="2" net="gnd"/></component>
  </components>
  <tests>
    <test id="rail_ok">
      <setup><set_voltage net="v_in" value="5V"/></setup>
      <run duration="10ms"/>
      <assert_voltage net="sense" min="1.6V" max="1.7V"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id="analog_only" default="true">
      <backend type="ngspice"/>
      <run test="rail_ok"/>
    </profile>
  </simulation_profiles>
</system>"""


_PIN_CONVENTIONS = {
    "resistor": '"1", "2"',
    "capacitor": '"1", "2"',
    "voltage_source": '"p", "n"',
    "current_source": '"p", "n"',
    "generic_load": '"p", "n"',
    "diode": '"a", "c"',
    "bjt": '"C", "B", "E"',
    "mosfet": '"G", "D", "S"',
    "ldo": '"in", "out", "gnd"',
}

# Order types are presented in the contract (stable, readable).
_TYPE_ORDER = [
    "resistor", "capacitor", "voltage_source", "current_source",
    "generic_load", "diode", "bjt", "mosfet", "ldo", "mcu", "sensor",
]


def _component_rules() -> str:
    from .registry import COMPONENT_SPECS

    lines: list[str] = []
    ordered = [t for t in _TYPE_ORDER if t in COMPONENT_SPECS]
    ordered += [t for t in sorted(COMPONENT_SPECS) if t not in _TYPE_ORDER]
    for ctype in ordered:
        spec = COMPONENT_SPECS[ctype]
        parts: list[str] = [f"`{ctype}`"]
        pins = spec.get("required_pins")
        if pins:
            parts.append(f"pins {', '.join(pins)}")
        elif ctype in _PIN_CONVENTIONS:
            parts.append(f"pins {_PIN_CONVENTIONS[ctype]}")
        if spec.get("value_required"):
            parts.append("requires <value>")
        if spec.get("required_any"):
            parts.append("requires one of: " + ", ".join(spec["required_any"]))
        if spec.get("required_properties"):
            parts.append("requires properties: " + ", ".join(spec["required_properties"]))
        if ctype in {"bjt", "mosfet"}:
            parts.append('set spice_model (e.g. "NPN"/"PNP" or "NMOS"/"PMOS")')
        if ctype in {"mcu", "ldo"}:
            parts.append("must connect to a power net AND the ground net")
        lines.append("  - " + "; ".join(parts))
    return "\n".join(lines)


def _mcu_rules() -> str:
    from .registry import MCUS

    parts = ", ".join(sorted(MCUS))
    return (
        f"MCU `part` MUST be one of: {parts}. Each MCU pin's optional `function` "
        "must be one the part supports (e.g. ADC1_CH0..n, I2C_SDA, I2C_SCL, "
        "UART_TX, UART_RX, GPIO, GPIO_OUT). Use 'validate_design' / fix reported "
        "UNKNOWN_MCU_PART or UNSUPPORTED_PIN_FUNCTION errors before finalizing."
    )


@lru_cache(maxsize=1)
def air_contract() -> str:
    """The full, authoritative AIR authoring contract (registry-derived)."""
    return f"""AIR XML AUTHORING CONTRACT (v0.1) - follow EXACTLY; the validator enforces all of this.

ROOT: <system name="..." ir_version="0.1"> ... </system>  (never <design>).
REQUIRED SECTIONS (all must be present): <metadata>, <nets>, <components>, <tests>, <simulation_profiles>.

METADATA: <metadata> with <title>, <description>, <author>, <created_at> (ISO-8601).

NETS: <nets> of <net id="..." role="..." [nominal_voltage="3.3V"]/>.
  - Identify nets with `id` (NEVER `name`).
  - role is one of: power, ground, analog_signal, digital_signal.
  - EXACTLY one ground net is required (role="ground").
  - Every pin's `net` MUST reference a declared net id.

COMPONENTS: <components> of <component id="..." type="..." [part="..."]> with child
<pin name="..." net="..." [function="..."]/>, optional <value>...</value>, optional
<property name="..." value="..."/>.
  - Identify components with `id`; the kind goes in `type` (NEVER put the type in `part`).
  - List <pin> elements directly under <component> (do NOT wrap them in <pins>).
  - `type` MUST be one of the component kinds below, with these requirements:
{_component_rules()}
  - Pin name conventions: R/C "1"/"2"; sources "p"/"n"; diode "a"/"c"; BJT "C"/"B"/"E";
    MOSFET "G"/"D"/"S"; LDO "in"/"out"/"gnd".
  - {_mcu_rules()}

VALUES & UNITS: put scalar values in a <value> child (e.g. <value>10k</value>,
<value>100nF</value>, <value>5V</value>, <value>800mA</value>) - not in an attribute.

ANALOG / PROBES (optional): <analog><subsystem id="..."><uses component="..."/>
<probe id="..." net="..." quantity="voltage"/></subsystem></analog>. Only `voltage`
probes are simulated; current is observed via assert_current on a generic_load.

TESTS: <tests> of <test id="..."> with <setup> (<set_voltage net="..." value="..."/>,
<set_current component="..." value="..."/>, <load_step component="..." from="..." to="..." at="..." rise="..."/>),
<run duration="..."/>, and assertions <assert_voltage net="..." min="..." max="..."/> or
<assert_current component="..." min="..." max="..."/>. Asserted nets/components MUST exist.

SIMULATION PROFILES: <simulation_profiles> of <profile id="..." default="true">.
  - Each profile MUST contain at least one <backend type="ngspice"/> (or "renode").
  - <run test="..."/> entries MUST reference existing test ids.
  - <include subsystem="..."/> entries MUST reference existing analog subsystems.

FIRMWARE (optional): <firmware><project id="..." target="<mcu id>" framework="arduino" language="cpp">
<board>...</board></project><binding id="..."><signal name="..."/><component ref="<mcu id>"/>
<peripheral>ADC1</peripheral><channel>ADC1_CH0</channel><net>...</net></binding>
<task id="..." target="<project id>"><period>60s</period><read_adc binding="..." into="raw"/>
<convert expr="..." into="mv"/><log value="mv"/></task></firmware>.

COMMON MISTAKES TO AVOID: using `name` instead of `id` on nets/components/tests/profiles;
putting the kind in `part` instead of `type`; wrapping pins in <pins>; omitting <backend>
in a profile; omitting the ground net; omitting required LDO properties; inventing an
unsupported MCU part or pin function.

COMPLETE VALID EXAMPLE (this passes validation - imitate its shape):
{GOLDEN_DESIGN}"""


def chat_system_instruction() -> str:
    return (
        "You are an expert electronics engineer assistant in AINativeSPice. You design "
        "circuits in AIR XML and implement MCU firmware in C++.\n\n"
        "CLOSED-LOOP DISCIPLINE: before presenting any new or edited design, reconcile it "
        "against the contract below and call 'validate_design' (or 'run_design_check') and "
        "resolve every reported error. Use 'list_registry_parts' to confirm part names exist.\n\n"
        "RESPONSE FORMAT:\n"
        "1. NEW design: open with 'Building circuit...', a 1-2 sentence summary, then one ```xml block.\n"
        "2. MODIFY existing: open with 'Editing circuit...', a short change summary, then the ```xml.\n"
        "3. FIRMWARE: use 'write_firmware_file', then summarize.\n"
        "4. QUESTION: answer conversationally; include XML only if asked or clearly relevant.\n\n"
        + air_contract()
    )


def generate_system_instruction(registry_context: dict[str, object]) -> str:
    return (
        "You are an expert electronics architect. Produce ONE complete AIR XML design that "
        "passes validation for the user's request.\n\n"
        + air_contract()
        + f"\n\nAvailable registry parts: {json.dumps(registry_context)}\n\n"
        "Respond with a JSON object: {\"design_xml\": \"<system ...>...</system>\", "
        "\"architecture_summary\": \"...\"}. design_xml must be one complete, valid AIR document."
    )


def generate_user_prompt(prompt: str, prior_error: str | None = None) -> str:
    base = f"Design request:\n{prompt}"
    if prior_error:
        base += (
            "\n\nYour previous attempt failed AIR validation with these errors. Return a "
            "corrected full design that fixes them (re-check against the contract):\n" + prior_error
        )
    return base


# Shared AIR <patch> grammar (used by both repair and edit). A patch is a diff of
# replace/add/remove ops keyed by XPath; far cheaper to generate than a full design.
_PATCH_FORMAT = (
    "AIR <patch> FORMAT - patch_xml is a small diff document:\n"
    "<patch id=\"fix\">\n"
    "  <reason>why</reason>\n"
    "  <replace path=\"/system/components/component[@id='R_BOT']/value\"><value>4.7k</value></replace>\n"
    "  <add path=\"/system/components\"><component id=\"C1\" type=\"capacitor\"><value>100nF</value>"
    "<pin name=\"1\" net=\"sense\"/><pin name=\"2\" net=\"gnd\"/></component></add>\n"
    "  <remove path=\"/system/components/component[@id='OLD']\"/>\n"
    "</patch>\n"
    "Rules: ops are replace/add/remove; a `path` must already exist unless the op is 'add' "
    "(whose path is the PARENT element to append into); use @id predicates to target elements; "
    "make the SMALLEST change that satisfies the request and keep everything else intact."
)


def repair_prompt(context: dict[str, object], prior_error: str | None = None) -> str:
    diagnostics = context.get("validation_diagnostics", [])
    report = context.get("simulation_report")
    parts = [
        "You are repairing an AIR circuit design. Return the SMALLEST AIR <patch> that makes "
        "the design validate and pass its tests.\n\n",
        air_contract(),
        "\n\n" + _PATCH_FORMAT,
        "\nRespond with a JSON object: {\"patch_xml\": \"<patch ...>...</patch>\", \"reason\": \"...\"}.\n",
        "\nCURRENT DESIGN:\n" + str(context.get("design_xml", "")),
        "\n\nVALIDATION DIAGNOSTICS:\n" + json.dumps(diagnostics, indent=2),
    ]
    if report:
        parts.append("\n\nSIMULATION REPORT:\n" + json.dumps(report, indent=2))
    if prior_error:
        parts.append("\n\nYour previous patch still left these errors; produce a better patch:\n" + prior_error)
    return "".join(parts)


def firmware_system_instruction() -> str:
    return (
        "You are an expert embedded firmware engineer. Write a COMPLETE, COMPILABLE "
        "Arduino-framework C++ main.cpp for the target board. Use only <Arduino.h> and "
        "standard Arduino APIs (Serial, pinMode, digitalWrite, analogRead, analogWrite, "
        "millis, micros, delay, constrain, map) and the C/C++ standard library - NO external "
        "libraries. Implement the FULL requested algorithm (not a stub). Respond with a JSON "
        "object: {\"main_cpp\": \"...complete source...\"}."
    )


def firmware_prompt(hardware_context: str, spec: str, prior_error: str | None = None) -> str:
    parts = [
        "Write the firmware main.cpp for this product.\n\n",
        "TARGET HARDWARE (use these exact GPIO numbers):\n", hardware_context, "\n\n",
        "FIRMWARE SPECIFICATION:\n", spec, "\n\n",
        "Requirements: one self-contained main.cpp with setup() and loop(); read inputs and "
        "drive outputs using the GPIO numbers above; print telemetry over Serial; implement "
        "the complete control logic described. It MUST compile cleanly with the espressif32 / "
        "ststm32 Arduino toolchain.",
    ]
    if prior_error:
        parts.append(
            "\n\nThe previous version FAILED TO COMPILE with these errors. Return a corrected, "
            "complete main.cpp that fixes them:\n" + prior_error
        )
    return "".join(parts)


def edit_patch_prompt(current_xml: str, instruction: str, prior_error: str | None = None) -> str:
    """Ask for a minimal AIR <patch> applying a natural-language change to an
    existing design - far cheaper to generate than re-emitting the whole design."""
    parts = [
        "You are editing an existing AIR design. Express the requested change as the SMALLEST "
        "AIR <patch> (a diff); do NOT rewrite the whole design.\n\n",
        air_contract(),
        "\n\n" + _PATCH_FORMAT,
        "\nRespond with a JSON object: {\"patch_xml\": \"<patch ...>...</patch>\", \"reason\": \"...\"}.\n",
        "\nCURRENT DESIGN:\n" + current_xml,
        "\n\nREQUESTED CHANGE:\n" + instruction,
    ]
    if prior_error:
        parts.append("\n\nYour previous patch failed; produce a corrected patch:\n" + prior_error)
    return "".join(parts)
