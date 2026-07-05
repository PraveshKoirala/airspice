/**
 * Ported agent prompts (issue #18 deliverable 5; epic #16 "prompt migration":
 * port prompts VERBATIM into a shared, versioned prompt module with provenance
 * comments; prompt edits after the port require a benchmark run — #19's harness).
 *
 * PROVENANCE — this is a VERBATIM port of packages/core/src/air/prompts.py. Every
 * function below carries a `// PORT:` reference to the Python source it mirrors.
 * The registry-derived contract (`air_contract`) is generated from air-ts's
 * COMPONENT_SPECS / MCUS — the SAME registry the Python prompt derives from and
 * the validator enforces — so the contract text the model sees can never drift
 * from what the gate checks (prompts.py header rationale, ported verbatim).
 *
 * Do NOT edit the prompt TEXT here without benchmark evidence (AGENTS.md rule 14,
 * epic #16). Deriving the registry lists from air-ts instead of a hardcoded copy
 * is the faithful port of prompts.py's own registry derivation, not an edit to
 * the tuned language.
 */

import { COMPONENT_SPECS, MCUS } from "air-ts";
import type { ComponentSpec } from "air-ts";

// PORT: prompts.py DEFAULT_GEMINI_MODEL / DEFAULT_OPENAI_MODEL. (Anthropic's
// default is set in models.ts per issue #17; these mirror the Python constants.)
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

// PORT: prompts.py GOLDEN_DESIGN — the canonical few-shot pattern, verbatim.
export const GOLDEN_DESIGN = `<system name="example_regulator" ir_version="0.1">
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
</system>`;

// PORT: prompts.py _PIN_CONVENTIONS.
const PIN_CONVENTIONS: Record<string, string> = {
  resistor: '"1", "2"',
  capacitor: '"1", "2"',
  voltage_source: '"p", "n"',
  current_source: '"p", "n"',
  generic_load: '"p", "n"',
  diode: '"a", "c"',
  bjt: '"C", "B", "E"',
  mosfet: '"G", "D", "S"',
  ldo: '"in", "out", "gnd"',
};

// PORT: prompts.py _TYPE_ORDER — stable, readable presentation order.
const TYPE_ORDER = [
  "resistor", "capacitor", "voltage_source", "current_source",
  "generic_load", "diode", "bjt", "mosfet", "ldo", "mcu", "sensor",
];

// PORT: prompts.py _component_rules() — verbatim logic over COMPONENT_SPECS.
function componentRules(): string {
  const specs = COMPONENT_SPECS;
  const lines: string[] = [];
  const ordered = TYPE_ORDER.filter((t) => t in specs);
  ordered.push(...Object.keys(specs).filter((t) => !TYPE_ORDER.includes(t)).sort());
  for (const ctype of ordered) {
    const spec = specs[ctype] as ComponentSpec;
    const parts: string[] = ["`" + ctype + "`"];
    const pins = spec.required_pins;
    if (pins && pins.length) {
      parts.push(`pins ${pins.join(", ")}`);
    } else if (ctype in PIN_CONVENTIONS) {
      parts.push(`pins ${PIN_CONVENTIONS[ctype]}`);
    }
    if (spec.value_required) parts.push("requires <value>");
    if (spec.required_any) parts.push("requires one of: " + spec.required_any.join(", "));
    if (spec.required_properties) {
      parts.push("requires properties: " + spec.required_properties.join(", "));
    }
    if (ctype === "bjt" || ctype === "mosfet") {
      parts.push('set spice_model (e.g. "NPN"/"PNP" or "NMOS"/"PMOS")');
    }
    if (ctype === "mcu" || ctype === "ldo") {
      parts.push("must connect to a power net AND the ground net");
    }
    lines.push("  - " + parts.join("; "));
  }
  return lines.join("\n");
}

// PORT: prompts.py _mcu_rules() — verbatim over MCUS keys.
function mcuRules(): string {
  const parts = Object.keys(MCUS).sort().join(", ");
  return (
    `MCU \`part\` MUST be one of: ${parts}. Each MCU pin's optional \`function\` ` +
    "must be one the part supports (e.g. ADC1_CH0..n, I2C_SDA, I2C_SCL, " +
    "UART_TX, UART_RX, GPIO, GPIO_OUT). Use 'validate_design' / fix reported " +
    "UNKNOWN_MCU_PART or UNSUPPORTED_PIN_FUNCTION errors before finalizing."
  );
}

let _contractCache: string | null = null;

// PORT: prompts.py air_contract() — the full authoritative contract, verbatim
// (with the registry-derived component/MCU rules spliced in, as in Python).
export function airContract(): string {
  if (_contractCache !== null) return _contractCache;
  _contractCache = `AIR XML AUTHORING CONTRACT (v0.1) - follow EXACTLY; the validator enforces all of this.

ROOT: <system name="..." ir_version="0.1"> ... </system>  (never <design>).
REQUIRED SECTIONS (all must be present): <metadata>, <nets>, <components>, <tests>, <simulation_profiles>.

METADATA: <metadata> with <title>, <description>, <author>, <created_at> (ISO-8601).

NETS: <nets> of <net id="..." role="..." [nominal_voltage="3.3V"]/>.
  - Identify nets with \`id\` (NEVER \`name\`).
  - role is one of: power, ground, analog_signal, digital_signal.
  - EXACTLY one ground net is required (role="ground").
  - Every pin's \`net\` MUST reference a declared net id.

COMPONENTS: <components> of <component id="..." type="..." [part="..."]> with child
<pin name="..." net="..." [function="..."]/>, optional <value>...</value>, optional
<property name="..." value="..."/>.
  - Identify components with \`id\`; the kind goes in \`type\` (NEVER put the type in \`part\`).
  - List <pin> elements directly under <component> (do NOT wrap them in <pins>).
  - \`type\` MUST be one of the component kinds below, with these requirements:
${componentRules()}
  - Pin name conventions: R/C "1"/"2"; sources "p"/"n"; diode "a"/"c"; BJT "C"/"B"/"E";
    MOSFET "G"/"D"/"S"; LDO "in"/"out"/"gnd".
  - ${mcuRules()}

VALUES & UNITS: put scalar values in a <value> child (e.g. <value>10k</value>,
<value>100nF</value>, <value>5V</value>, <value>800mA</value>) - not in an attribute.

ANALOG / PROBES (optional): <analog><subsystem id="..."><uses component="..."/>
<probe id="..." net="..." quantity="voltage"/></subsystem></analog>. Only \`voltage\`
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

COMMON MISTAKES TO AVOID: using \`name\` instead of \`id\` on nets/components/tests/profiles;
putting the kind in \`part\` instead of \`type\`; wrapping pins in <pins>; omitting <backend>
in a profile; omitting the ground net; omitting required LDO properties; inventing an
unsupported MCU part or pin function.

COMPLETE VALID EXAMPLE (this passes validation - imitate its shape):
${GOLDEN_DESIGN}`;
  return _contractCache;
}

/**
 * The system prompt for the browser conversation runner.
 *
 * PORT: prompts.py chat_system_instruction() — verbatim. The one faithful
 * ADAPTATION for the browser tool runtime (not a language edit): the tool NAMES
 * are the browser registry's (get_design/set_design/validate_design/
 * run_simulation/propose_patch/preview_patch/list_registry_components) rather
 * than the Python chat tools. The RESPONSE FORMAT block — "Building circuit..." /
 * "Editing circuit..." (Building/Editing modes) — is preserved verbatim, since
 * the ported prompt was tuned around exactly those cues.
 */
export function chatSystemInstruction(): string {
  return (
    "You are an expert electronics engineer assistant in AINativeSPice. You design " +
    "circuits in AIR XML and implement MCU firmware in C++.\n\n" +
    "CLOSED-LOOP DISCIPLINE: before presenting any new or edited design, reconcile it " +
    "against the contract below and call 'validate_design' (or 'run_simulation') and " +
    "resolve every reported error. Use 'list_registry_components' to confirm part names exist. " +
    "Stage designs with 'set_design' and edits with 'propose_patch'; both run the " +
    "validation gate and stage a proposal for the user to Apply — they do not write directly.\n\n" +
    "RESPONSE FORMAT:\n" +
    "1. NEW design: open with 'Building circuit...', a 1-2 sentence summary, then stage it via 'set_design'.\n" +
    "2. MODIFY existing: open with 'Editing circuit...', a short change summary, then stage via 'propose_patch' (or 'set_design' for a full rewrite).\n" +
    "3. QUESTION: answer conversationally; stage XML only if asked or clearly relevant.\n\n" +
    airContract()
  );
}
