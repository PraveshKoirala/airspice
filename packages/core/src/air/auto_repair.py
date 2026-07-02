from __future__ import annotations

import json
from pathlib import Path
from xml.sax.saxutils import escape

from .model import Component, SystemIR
from .parser import parse_file
from .units import parse_quantity
from .validation import validate_ir, validate_tree


def propose_repair_patch(design_path: Path, report_path: Path | None = None) -> str:
    ir, tree = parse_file(design_path)
    diagnostics = [diagnostic.to_dict() for diagnostic in validate_tree(tree) + validate_ir(ir)]
    if report_path:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        diagnostics.extend(report.get("diagnostics", []))
    operations = []
    reasons = []
    codes = {diagnostic.get("code") for diagnostic in diagnostics}

    if "ADC_INPUT_EXCEEDS_VREF" in codes or "ASSERT_FAILED" in codes:
        op = _repair_adc_divider(ir)
        if op:
            reasons.append("Adjust resistor divider so ADC sense voltage lands inside the test range.")
            operations.extend(op)

    if "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT" in codes:
        op = _repair_regulator_limit(ir, diagnostics)
        if op:
            reasons.append("Increase regulator current limit to exceed declared load current.")
            operations.append(op)

    if "SOURCE_OVERLOADED" in codes:
        op = _repair_source_limit(ir, diagnostics)
        if op:
            reasons.append("Increase source current limit to exceed total system load.")
            operations.append(op)

    if "I2C_PULLUP_TOO_WEAK" in codes or "I2C_PULLUP_TOO_STRONG" in codes or "I2C_VOLTAGE_MISMATCH" in codes:
        ops = _repair_i2c_pullups(ir, diagnostics)
        if ops:
            reasons.append("Adjust I2C pull-up resistors to standard values and match MCU voltage domain.")
            operations.extend(ops)

    if not operations:
        reasons.append("No deterministic repair recipe matched the current diagnostics.")
    lines = [f'<patch id="patch_auto_repair_{ir.name}">', "  <reason>"]
    for reason in reasons:
        lines.append(f"    {escape(reason)}")
    lines.extend(["  </reason>"])
    lines.extend(operations)
    lines.append("</patch>")
    return "\n".join(lines) + "\n"


def _repair_adc_divider(ir: SystemIR) -> list[str]:
    test = next((test for test in ir.tests.values() for assertion in test.assertions if assertion.get("op") == "assert_voltage"), None)
    if not test:
        return []
    assertion = next(assertion for assertion in test.assertions if assertion.get("op") == "assert_voltage")
    sense_net = assertion.get("net", "")
    source_net = next(iter(test.setup), "")
    source_voltage = parse_quantity(test.setup[source_net], "V") if source_net else None
    target = (parse_quantity(assertion.get("min", "0V"), "V") + parse_quantity(assertion.get("max", "0V"), "V")) / 2.0
    if not source_voltage or target <= 0 or target >= source_voltage:
        return []
    top, bottom = _find_divider(ir, sense_net, source_net)
    if not top or not bottom:
        return []
    top_value = "1M"
    top_ohms = 1_000_000.0
    bottom_ohms = top_ohms * target / (source_voltage - target)
    bottom_value = _engineering_resistor(bottom_ohms)
    return [
        f'  <replace path="/system/components/component[@id=\'{top.id}\']/value">\n    <value>{top_value}</value>\n  </replace>',
        f'  <replace path="/system/components/component[@id=\'{bottom.id}\']/value">\n    <value>{bottom_value}</value>\n  </replace>',
    ]


def _find_divider(ir: SystemIR, sense_net: str, source_net: str) -> tuple[Component | None, Component | None]:
    top = None
    bottom = None
    ground_nets = {net.id for net in ir.nets.values() if net.role == "ground"}
    for component in ir.components.values():
        if component.type != "resistor" or len(component.pins) < 2:
            continue
        nets = {pin.net for pin in component.pins.values()}
        if sense_net in nets and source_net in nets:
            top = component
        if sense_net in nets and nets.intersection(ground_nets):
            bottom = component
    return top, bottom


def _repair_regulator_limit(ir: SystemIR, diagnostics: list[dict[str, object]]) -> str | None:
    diagnostic = next((item for item in diagnostics if item.get("code") == "RAIL_LOAD_EXCEEDS_REGULATOR_LIMIT"), None)
    if not diagnostic:
        return None
    related = diagnostic.get("related_elements", [])
    regulator_id = next((item for item in related if str(item).startswith("U_")), None)
    observed = diagnostic.get("observed", {})
    if not regulator_id or not isinstance(observed, dict) or "load_current" not in observed:
        return None
    try:
        repaired_current = parse_quantity(str(observed["load_current"]), "A") * 1.25
    except ValueError:
        return None
    value = _engineering_current(repaired_current)
    if regulator_id not in ir.components:
        return None
    return f'  <replace path="/system/components/component[@id=\'{regulator_id}\']/property[@name=\'iout_max\']">\n    <property name="iout_max" value="{value}"/>\n  </replace>'


def _repair_source_limit(ir: SystemIR, diagnostics: list[dict[str, object]]) -> str | None:
    diagnostic = next((item for item in diagnostics if item.get("code") == "SOURCE_OVERLOADED"), None)
    if not diagnostic:
        return None
    related = diagnostic.get("related_elements", [])
    source_id = str(related[0]) if related else None
    observed = diagnostic.get("observed", {})
    if not source_id or source_id not in ir.components or not isinstance(observed, dict) or "total_draw" not in observed:
        return None
    try:
        new_limit = parse_quantity(str(observed["total_draw"]), "A") * 1.25
        value = _engineering_current(new_limit)
        return f'  <replace path="/system/components/component[@id=\'{source_id}\']/property[@name=\'i_max\']">\n    <property name="i_max" value="{value}"/>\n  </replace>'
    except ValueError:
        return None


def _repair_i2c_pullups(ir: SystemIR, diagnostics: list[dict[str, object]]) -> list[str]:
    ops = []
    # Identify which interfaces have pullup issues
    iface_ids = {str(d.get("related_elements", [""])[0]) for d in diagnostics if d.get("code") in {"I2C_PULLUP_TOO_WEAK", "I2C_PULLUP_TOO_STRONG", "I2C_VOLTAGE_MISMATCH"}}
    
    for iface_id in iface_ids:
        if iface_id not in ir.interfaces:
            continue
        iface = ir.interfaces[iface_id]
        
        # Get target rail from MCU if possible
        data = iface.data
        controller_info = data.get("controller", {})
        mcu = ir.components.get(str(controller_info.get("component", "")))
        target_rail = "3v3"
        if mcu and mcu.type == "mcu" and mcu.pins.get("3V3"):
            target_rail = mcu.pins["3V3"].net
            
        # Get speed to decide value
        def get_val(key, default=None):
            if key in data: return data[key]
            properties = _as_list(data.get("property"))
            for p in properties:
                if p.get("name") == key: return p.get("value")
            return default
        
        speed = get_val("speed", "100kHz")
        try:
            speed_hz = parse_quantity(str(speed), "Hz")
        except ValueError:
            speed_hz = 100000
        
        suggested_value = "2.2k" if speed_hz > 100000 else "4.7k"

        pullups = _as_list(iface.data.get("pullup"))
        for pullup in pullups:
            net = pullup.get("net")
            if net:
                ops.append(
                    f'  <replace path="/system/interfaces/interface[@id=\'{iface_id}\']/pullup[@net=\'{net}\']">\n'
                    f'    <pullup net="{net}" value="{suggested_value}" to="{target_rail}"/>\n'
                    f'  </replace>'
                )
    
    return ops


def _as_list(value: object) -> list[dict[str, str]]:
    if value is None:
        return []
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _engineering_resistor(ohms: float) -> str:
    if ohms >= 1_000_000:
        return f"{ohms / 1_000_000:.3g}M"
    if ohms >= 1_000:
        return f"{ohms / 1_000:.3g}k"
    return f"{ohms:.3g}"


def _engineering_current(amps: float) -> str:
    if amps >= 1.0:
        return f"{amps:.3g}A"
    if amps >= 0.001:
        return f"{amps * 1000:.3g}mA"
    return f"{amps * 1_000_000:.3g}uA"

