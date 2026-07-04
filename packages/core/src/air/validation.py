from __future__ import annotations

from xml.etree import ElementTree as ET

from .diagnostics import Diagnostic, DiagnosticBuilder
from .model import SystemIR
from .registry import COMPONENT_SPECS, MCUS, PASSIVE_TYPES, SUPPORTED_SPICE_TYPES
from .spice import BUILTIN_SPICE_MODELS, BUILTIN_SPICE_SUBCKTS
from .units import parse_quantity


# Component types whose device line carries a SPICE ``.model`` reference the
# compiler must be able to back (see spice._component_line). For these, a
# ``spice_model`` outside the builtin set means the emitted netlist references a
# model with no definition -- ngspice cannot run it.
_MODELLED_SPICE_TYPES = {"bjt", "mosfet", "diode"}


def validate_tree(tree: ET.ElementTree) -> list[Diagnostic]:
    builder = DiagnosticBuilder()
    diagnostics: list[Diagnostic] = []
    root = tree.getroot()
    if root.tag != "system":
        diagnostics.append(builder.make("error", "schema", "INVALID_ROOT", "Root element must be <system>."))
        return diagnostics
    for attr in ("name", "ir_version"):
        if not root.attrib.get(attr):
            diagnostics.append(builder.make("error", "schema", "MISSING_SYSTEM_ATTR", f"System is missing required '{attr}' attribute."))
    for section in ("metadata", "nets", "components", "tests", "simulation_profiles"):
        if root.find(section) is None:
            diagnostics.append(builder.make("error", "schema", "MISSING_SECTION", f"Missing <{section}> section."))
    for tag, query in {
        "net": "./nets/net",
        "component": "./components/component",
        "test": "./tests/test",
        "profile": "./simulation_profiles/profile",
    }.items():
        ids: dict[str, int] = {}
        for element in root.findall(query):
            element_id = element.attrib.get("id")
            if element_id:
                ids[element_id] = ids.get(element_id, 0) + 1
        for element_id, count in ids.items():
            if count > 1:
                diagnostics.append(builder.make("error", "schema", "DUPLICATE_ID", f"Duplicate {tag} id '{element_id}'.", [element_id]))
    return diagnostics


def validate_ir(ir: SystemIR) -> list[Diagnostic]:
    builder = DiagnosticBuilder()
    diagnostics: list[Diagnostic] = []

    if not ir.nets:
        diagnostics.append(builder.make("error", "semantic", "NO_NETS", "Design must define at least one net."))
    ground_nets = [net.id for net in ir.nets.values() if net.role == "ground"]
    if not ground_nets:
        diagnostics.append(builder.make("error", "electrical", "MISSING_GROUND", "Design must define a ground net."))

    component_ids = [cid for cid in ir.components if cid]
    if len(component_ids) != len(set(component_ids)):
        diagnostics.append(builder.make("error", "semantic", "DUPLICATE_COMPONENT_ID", "Component IDs must be unique."))

    for component in ir.components.values():
        if not component.id:
            diagnostics.append(builder.make("error", "semantic", "MISSING_COMPONENT_ID", "A component is missing an id."))
        if not component.type:
            diagnostics.append(builder.make("error", "semantic", "MISSING_COMPONENT_TYPE", f"Component {component.id} is missing a type.", [component.id]))
        diagnostics.extend(_validate_component_registry_rules(component, builder))
        diagnostics.extend(_validate_spice_models(component, builder))
        for pin in component.pins.values():
            if pin.net not in ir.nets:
                diagnostics.append(
                    builder.make(
                        "error",
                        "semantic",
                        "UNKNOWN_NET",
                        f"Component {component.id}.{pin.name} references undefined net '{pin.net}'.",
                        [component.id, pin.net],
                    )
                )
        if component.type not in PASSIVE_TYPES:
            pin_nets = {pin.net for pin in component.pins.values()}
            has_ground = any(ir.nets.get(net_id) and ir.nets[net_id].role == "ground" for net_id in pin_nets)
            has_power = any(ir.nets.get(net_id) and ir.nets[net_id].role == "power" for net_id in pin_nets)
            if component.type in {"mcu", "ldo"} and (not has_ground or not has_power):
                diagnostics.append(
                    builder.make(
                        "error",
                        "power",
                        "MISSING_POWER_OR_GROUND",
                        f"Non-passive component {component.id} must connect to power and ground.",
                        [component.id],
                    )
                )
        if component.type == "mcu":
            diagnostics.extend(_validate_mcu(component, builder))
        if component.type not in SUPPORTED_SPICE_TYPES and component.type not in {"mcu"}:
            diagnostics.append(builder.make("warning", "compiler", "UNSUPPORTED_SPICE_TYPE", f"Component {component.id} type {component.type} is not supported by the v0.1 SPICE compiler.", [component.id]))
        if component.type == "generic_load":
            diagnostics.extend(_validate_generic_load(component, builder))

    for domain in ir.power_domains.values():
        if domain.net not in ir.nets:
            diagnostics.append(builder.make("error", "power", "POWER_DOMAIN_UNKNOWN_NET", f"Power domain {domain.id} references undefined net '{domain.net}'.", [domain.id, domain.net]))
    diagnostics.extend(_validate_load_budget(ir, builder))

    for subsystem in ir.analog:
        for component_id in subsystem.uses:
            if component_id not in ir.components:
                diagnostics.append(builder.make("error", "analog", "UNKNOWN_ANALOG_COMPONENT", f"Analog subsystem {subsystem.id} references unknown component {component_id}.", [subsystem.id, component_id]))
        for probe in subsystem.probes:
            if probe.net not in ir.nets:
                diagnostics.append(builder.make("error", "analog", "UNKNOWN_PROBE_NET", f"Probe {probe.id} references undefined net '{probe.net}'.", [probe.id, probe.net]))

    for iface in ir.interfaces.values():
        if iface.type == "i2c":
            diagnostics.extend(_validate_i2c(ir, iface, builder))

    for project in ir.firmware_projects.values():
        if project.target not in ir.components:
            diagnostics.append(builder.make("error", "firmware", "UNKNOWN_FIRMWARE_TARGET", f"Firmware project {project.id} targets unknown component {project.target}.", [project.id, project.target]))
    for binding in ir.firmware_bindings.values():
        if binding.component not in ir.components:
            diagnostics.append(builder.make("error", "firmware", "UNKNOWN_BINDING_COMPONENT", f"Firmware binding {binding.id} references unknown component {binding.component}.", [binding.id, binding.component]))
        if binding.net not in ir.nets:
            diagnostics.append(builder.make("error", "firmware", "UNKNOWN_BINDING_NET", f"Firmware binding {binding.id} references unknown net {binding.net}.", [binding.id, binding.net]))
        diagnostics.extend(_validate_adc_binding(ir, binding, builder))
    for task in ir.firmware_tasks.values():
        if task.target not in ir.firmware_projects:
            diagnostics.append(builder.make("error", "firmware", "UNKNOWN_TASK_TARGET", f"Firmware task {task.id} targets unknown project {task.target}.", [task.id, task.target]))

    for test in ir.tests.values():
        for net_id in test.setup:
            if net_id.startswith("current:") or net_id.startswith("load_step:"):
                component_id = net_id.split(":", 1)[1]
                if component_id not in ir.components:
                    diagnostics.append(builder.make("error", "test", "TEST_SETUP_UNKNOWN_COMPONENT", f"Test {test.id} references unknown component {component_id}.", [test.id, component_id]))
            elif net_id not in ir.nets:
                diagnostics.append(builder.make("error", "test", "TEST_SETUP_UNKNOWN_NET", f"Test {test.id} sets undefined net {net_id}.", [test.id, net_id]))
        for assertion in test.assertions:
            net_id = assertion.get("net")
            if net_id and net_id not in ir.nets:
                diagnostics.append(builder.make("error", "test", "ASSERT_UNKNOWN_NET", f"Test {test.id} asserts undefined net {net_id}.", [test.id, net_id]))
            component_id = assertion.get("component")
            if component_id and component_id not in ir.components:
                diagnostics.append(builder.make("error", "test", "ASSERT_UNKNOWN_COMPONENT", f"Test {test.id} asserts unknown component {component_id}.", [test.id, component_id]))

    for profile in ir.simulation_profiles.values():
        for backend in profile.backends:
            if backend not in {"ngspice", "renode"}:
                diagnostics.append(builder.make("error", "simulation", "UNSUPPORTED_BACKEND", f"Profile {profile.id} uses unsupported backend {backend}.", [profile.id]))
        for test_id in profile.tests:
            if test_id not in ir.tests:
                diagnostics.append(builder.make("error", "simulation", "PROFILE_UNKNOWN_TEST", f"Profile {profile.id} references unknown test {test_id}.", [profile.id, test_id]))
        for subsystem_id in profile.included_subsystems:
            if subsystem_id not in {subsystem.id for subsystem in ir.analog}:
                diagnostics.append(builder.make("error", "simulation", "PROFILE_UNKNOWN_SUBSYSTEM", f"Profile {profile.id} references unknown subsystem {subsystem_id}.", [profile.id, subsystem_id]))

    return diagnostics


def _validate_i2c(ir: SystemIR, iface, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    data = iface.data
    
    # Helper to get property or direct attribute
    def get_val(key, default=None):
        if key in data: return data[key]
        properties = _as_list(data.get("property"))
        for p in properties:
            if p.get("name") == key: return p.get("value")
        return default

    for key in ("sda", "scl"):
        entry = data.get(key)
        if isinstance(entry, dict) and entry.get("net") not in ir.nets:
            diagnostics.append(builder.make("error", "interface", "I2C_UNKNOWN_NET", f"I2C interface {iface.id} {key} references an undefined net.", [iface.id]))
    
    pullups = _as_list(data.get("pullup"))
    if len(pullups) < 2:
        diagnostics.append(builder.make("error", "interface", "I2C_PULLUPS_NOT_DECLARED", f"I2C interface {iface.id} must declare SDA and SCL pullups.", [iface.id]))
    
    for pullup in pullups:
        pullup_net = pullup.get("net", "")
        rail = pullup.get("to", "")
        if pullup_net not in ir.nets:
            diagnostics.append(builder.make("error", "interface", "I2C_PULLUP_UNKNOWN_NET", f"I2C interface {iface.id} pullup references undefined net {pullup_net}.", [iface.id, pullup_net]))
        if rail not in ir.nets:
            diagnostics.append(builder.make("error", "interface", "I2C_PULLUP_UNKNOWN_RAIL", f"I2C interface {iface.id} pullup references undefined rail {rail}.", [iface.id, rail]))
        elif ir.nets[rail].role != "power":
            diagnostics.append(builder.make("error", "interface", "I2C_PULLUP_NOT_POWER_RAIL", f"I2C interface {iface.id} pullup rail {rail} is not a power net.", [iface.id, rail]))

    controller_info = data.get("controller", {})
    mcu = ir.components.get(str(controller_info.get("component", "")))
    if mcu and mcu.type == "mcu":
        mcu_rail_pin = mcu.pins.get("3V3") # Heuristic: check 3V3 rail
        if mcu_rail_pin:
            for pullup in pullups:
                rail = pullup.get("to")
                if rail and rail != mcu_rail_pin.net:
                    diagnostics.append(
                        builder.make(
                            "error",
                            "interface",
                            "I2C_VOLTAGE_MISMATCH",
                            f"I2C pullup rail {rail} differs from MCU rail {mcu_rail_pin.net}.",
                            [iface.id, rail, mcu.id],
                        )
                    )

    speed = get_val("speed", "100kHz")
    try:
        speed_hz = parse_quantity(str(speed), "Hz")
    except ValueError:
        speed_hz = 100000

    for pullup in pullups:
        val_str = pullup.get("value")
        if not val_str:
            continue
        try:
            val = parse_quantity(val_str, "ohm")
            if speed_hz > 100000 and val > 2200:
                diagnostics.append(builder.make("warning", "interface", "I2C_PULLUP_TOO_WEAK", f"I2C pullup {val_str} may be too weak for {speed}.", [iface.id]))
            elif val > 10000:
                diagnostics.append(builder.make("warning", "interface", "I2C_PULLUP_TOO_WEAK", f"I2C pullup {val_str} is very weak (>10k).", [iface.id]))
            elif val < 1000:
                diagnostics.append(builder.make("warning", "interface", "I2C_PULLUP_TOO_STRONG", f"I2C pullup {val_str} is very strong (<1k).", [iface.id]))
        except ValueError:
            pass

    return diagnostics


def _validate_mcu(component, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    if not component.part or component.part not in MCUS:
        diagnostics.append(builder.make("error", "pin", "UNKNOWN_MCU_PART", f"MCU component {component.id} uses unsupported part {component.part}.", [component.id]))
        return diagnostics
    registry = MCUS[component.part]
    for required_pin in registry["power_pins"]:
        if required_pin not in component.pins:
            diagnostics.append(builder.make("error", "pin", "MISSING_MCU_POWER_PIN", f"MCU {component.id} is missing required pin {required_pin}.", [component.id]))
    for pin in component.pins.values():
        if pin.name in registry["power_pins"]:
            continue
        supported = registry["pins"].get(pin.name)
        if supported is None:
            diagnostics.append(builder.make("warning", "pin", "UNKNOWN_MCU_PIN", f"MCU {component.id} pin {pin.name} is not in the registry.", [component.id]))
            continue
        if pin.function and pin.function not in supported:
            diagnostics.append(
                builder.make(
                    "error",
                    "pin",
                    "UNSUPPORTED_PIN_FUNCTION",
                    f"MCU {component.id} pin {pin.name} does not support function {pin.function}.",
                    [component.id, pin.name],
                    observed={"function": pin.function},
                    expected={"supported": sorted(supported)},
                )
            )
    return diagnostics


def _validate_spice_models(component, builder: DiagnosticBuilder) -> list[Diagnostic]:
    """Reject device lines that would reference an undefined SPICE model/subckt.

    The compiler defines only the generic builtin ``.model`` cards
    (spice.BUILTIN_SPICE_MODELS) and emits no ``.subckt`` definitions. The
    registry stores no per-part SPICE parameters, so a component that names a
    part-level ``spice_model`` (e.g. ``BSS138``, ``1N5819``, ``2N7002``) or any
    ``spice_subckt`` (e.g. ``LM358``, ``MCP73831``, ``BME280``) produces a
    netlist real ngspice cannot run ("unknown model" / "unknown subckt", exit 1).

    Making this a validation ERROR blocks compilation (service.compile_design /
    the exporter), so those broken netlists are never emitted -- the design fails
    validation honestly instead of compiling to something that silently can't
    simulate (issue #55).
    """
    diagnostics: list[Diagnostic] = []
    subckt = component.spice_subckt
    if subckt and subckt.strip().upper() not in BUILTIN_SPICE_SUBCKTS:
        diagnostics.append(
            builder.make(
                "error",
                "compiler",
                "UNDEFINED_SPICE_MODEL",
                f"Component {component.id} references SPICE subcircuit '{subckt}' with no "
                f"model source; the compiler emits no .subckt definition for it and ngspice "
                f"cannot simulate the design.",
                [component.id, subckt],
                observed={"spice_subckt": subckt},
                suggested_actions=[
                    "Import a SPICE subcircuit that defines this part, or",
                    "Model the part with supported primitives",
                ],
            )
        )
    model = component.spice_model
    if (
        model
        and component.type in _MODELLED_SPICE_TYPES
        and model.strip().upper() not in BUILTIN_SPICE_MODELS
    ):
        diagnostics.append(
            builder.make(
                "error",
                "compiler",
                "UNDEFINED_SPICE_MODEL",
                f"Component {component.id} references SPICE model '{model}' with no model "
                f"source; the compiler emits no .model card for it (only the generic "
                f"{', '.join(sorted(BUILTIN_SPICE_MODELS))}) and ngspice cannot simulate the design.",
                [component.id, model],
                observed={"spice_model": model},
                expected={"builtin_models": sorted(BUILTIN_SPICE_MODELS)},
                suggested_actions=[
                    "Import a SPICE .model that defines this part, or",
                    f"Use a generic model ({', '.join(sorted(BUILTIN_SPICE_MODELS))})",
                ],
            )
        )
    return diagnostics


def _validate_component_registry_rules(component, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    spec = COMPONENT_SPECS.get(component.type)
    if not spec:
        return diagnostics
    for pin_name in spec.get("required_pins", []):
        if pin_name not in component.pins:
            diagnostics.append(builder.make("error", "registry", "MISSING_REQUIRED_PIN", f"Component {component.id} is missing required pin {pin_name}.", [component.id, pin_name]))
    if spec.get("value_required") and not component.value:
        diagnostics.append(builder.make("error", "registry", "MISSING_REQUIRED_VALUE", f"Component {component.id} requires a <value>.", [component.id]))
    for property_name in spec.get("required_properties", []):
        if property_name not in component.properties:
            diagnostics.append(builder.make("error", "registry", "MISSING_REQUIRED_PROPERTY", f"Component {component.id} requires property {property_name}.", [component.id, property_name]))
    required_any = spec.get("required_any", [])
    if required_any:
        satisfied = any((name == "value" and component.value) or (name in component.properties) for name in required_any)
        if not satisfied:
            diagnostics.append(builder.make("error", "registry", "MISSING_REQUIRED_VALUE_OR_PROPERTY", f"Component {component.id} requires one of: {', '.join(required_any)}.", [component.id]))
    return diagnostics


def _validate_generic_load(component, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    if not component.value and "current" not in component.properties:
        diagnostics.append(builder.make("warning", "electrical", "LOAD_CURRENT_UNSPECIFIED", f"Generic load {component.id} should define a value or current property.", [component.id]))
    return diagnostics


def _validate_load_budget(ir: SystemIR, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    
    # Map net -> total current draw
    net_loads: dict[str, float] = {}
    
    # Initialize loads from generic_load components
    for load in ir.components.values():
        if load.type != "generic_load":
            continue
        pins = list(load.pins.values())
        if not pins: continue
        # Assume generic_load draws from pin[0] and returns to pin[1] (usually GND)
        net = pins[0].net
        current_str = load.properties.get("current") or load.value
        if current_str:
            try:
                current = parse_quantity(current_str, "A")
                net_loads[net] = net_loads.get(net, 0.0) + current
            except ValueError:
                pass

    # Propagate loads through regulators (LDOs)
    # Simple one-pass propagation (assumes no LDO-to-LDO loops for now)
    # Sort LDOs? No, just iterate until stable or once if simple.
    regulators = [c for c in ir.components.values() if c.type == "ldo"]
    for regulator in regulators:
        out_pin = regulator.pins.get("out")
        in_pin = regulator.pins.get("in")
        if not out_pin or not in_pin: continue
        
        out_current = net_loads.get(out_pin.net, 0.0)
        max_current_str = regulator.properties.get("iout_max")
        if max_current_str:
            try:
                max_current = parse_quantity(max_current_str, "A")
                if out_current > max_current:
                    diagnostics.append(
                        builder.make(
                            "error",
                            "power",
                            "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT",
                            f"Loads on {out_pin.net} ({out_current:.3g}A) exceed regulator {regulator.id} limit ({max_current_str}).",
                            [regulator.id, out_pin.net],
                            observed={"load_current": f"{out_current:.3g}A"},
                            expected={"max_current": max_current_str},
                        )
                    )
            except ValueError:
                pass
        
        # Add output current + IQ to input net load
        iq_str = regulator.properties.get("iq", "0")
        try:
            iq = parse_quantity(iq_str, "A")
            total_in = out_current + iq
            net_loads[in_pin.net] = net_loads.get(in_pin.net, 0.0) + total_in
        except ValueError:
            net_loads[in_pin.net] = net_loads.get(in_pin.net, 0.0) + out_current

    # Validate against voltage sources
    for source in [c for c in ir.components.values() if c.type == "voltage_source"]:
        pins = list(source.pins.values())
        if not pins: continue
        net = pins[0].net # Usually the positive terminal
        total_draw = net_loads.get(net, 0.0)
        imax_str = source.properties.get("i_max")
        if imax_str:
            try:
                imax = parse_quantity(imax_str, "A")
                if total_draw > imax:
                    diagnostics.append(
                        builder.make(
                            "error",
                            "power",
                            "SOURCE_OVERLOADED",
                            f"Total current draw from {source.id} ({total_draw:.3g}A) exceeds limit ({imax_str}).",
                            [source.id, net],
                            observed={"total_draw": f"{total_draw:.3g}A"},
                            expected={"max_current": imax_str},
                        )
                    )
            except ValueError:
                pass
                
    return diagnostics


def _validate_adc_binding(ir: SystemIR, binding, builder: DiagnosticBuilder) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    component = ir.components.get(binding.component)
    if not component or component.type != "mcu" or not component.part or component.part not in MCUS:
        return diagnostics
    adc = MCUS[component.part]["peripherals"].get(binding.peripheral)
    if not isinstance(adc, dict) or "vref" not in adc:
        return diagnostics
    try:
        vref = parse_quantity(str(adc["vref"]), "V")
    except ValueError:
        return diagnostics
    net = ir.nets.get(binding.net)
    if not net:
        return diagnostics
    estimated = _estimate_net_voltage(ir, binding.net)
    if estimated is not None and estimated > vref:
        diagnostics.append(
            builder.make(
                "error",
                "electrical",
                "ADC_INPUT_EXCEEDS_VREF",
                f"ADC binding {binding.id} can expose {binding.net} above {adc['vref']}.",
                [binding.id, binding.net, binding.component],
                observed={"estimated_voltage": f"{estimated:.6g}V"},
                expected={"max": adc["vref"]},
                suggested_actions=["Adjust divider values", "Bind ADC after a divider", "Use a higher ADC attenuation model"],
            )
        )
    return diagnostics


def _estimate_net_voltage(ir: SystemIR, net_id: str) -> float | None:
    known: dict[str, float] = {}
    for net in ir.nets.values():
        if net.role == "ground":
            known[net.id] = 0.0
        elif net.nominal_voltage:
            try:
                known[net.id] = parse_quantity(net.nominal_voltage, "V")
            except ValueError:
                pass
    for component in ir.components.values():
        if component.type == "ldo" and component.pins.get("out") and component.properties.get("vout"):
            try:
                known[component.pins["out"].net] = parse_quantity(component.properties["vout"], "V")
            except ValueError:
                pass
    if net_id in known:
        return known[net_id]
    # One-node divider estimate, enough for the MVP battery-sense case.
    conductance_sum = 0.0
    weighted_voltage = 0.0
    for component in ir.components.values():
        if component.type != "resistor" or not component.value or len(component.pins) < 2:
            continue
        pins = list(component.pins.values())
        nets = [pins[0].net, pins[1].net]
        if net_id not in nets:
            continue
        other = nets[1] if nets[0] == net_id else nets[0]
        if other not in known:
            continue
        try:
            resistance = parse_quantity(component.value, "ohm")
        except ValueError:
            continue
        conductance = 1.0 / resistance
        conductance_sum += conductance
        weighted_voltage += conductance * known[other]
    return weighted_voltage / conductance_sum if conductance_sum else None


def _as_list(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def has_errors(diagnostics: list[Diagnostic]) -> bool:
    return any(d.severity == "error" for d in diagnostics)
