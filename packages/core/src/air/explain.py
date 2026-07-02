from __future__ import annotations

from typing import Any

from .model import SystemIR


def summarize_design(ir: SystemIR) -> dict[str, Any]:
    rails = [
        {"id": net.id, "nominal_voltage": net.nominal_voltage}
        for net in ir.nets.values()
        if net.role == "power"
    ]
    grounds = [net.id for net in ir.nets.values() if net.role == "ground"]
    components = [
        {
            "id": component.id,
            "type": component.type,
            "part": component.part,
            "pins": {name: pin.net for name, pin in component.pins.items()},
        }
        for component in sorted(ir.components.values(), key=lambda c: c.id)
    ]
    return {
        "name": ir.name,
        "ir_version": ir.ir_version,
        "title": ir.metadata.title,
        "description": ir.metadata.description,
        "nets": {
            "count": len(ir.nets),
            "grounds": grounds,
            "power_rails": rails,
            "signals": [net.id for net in ir.nets.values() if net.role not in {"power", "ground"}],
        },
        "components": components,
        "interfaces": [
            {"id": iface.id, "type": iface.type, "data": iface.data}
            for iface in sorted(ir.interfaces.values(), key=lambda i: i.id)
        ],
        "firmware": {
            "projects": [project.__dict__ for project in ir.firmware_projects.values()],
            "bindings": [binding.__dict__ for binding in ir.firmware_bindings.values()],
            "tasks": [task.__dict__ for task in ir.firmware_tasks.values()],
        },
        "tests": [
            {"id": test.id, "duration": test.duration, "assertions": test.assertions}
            for test in ir.tests.values()
        ],
        "simulation_profiles": [
            {"id": profile.id, "backends": profile.backends, "tests": profile.tests}
            for profile in ir.simulation_profiles.values()
        ],
        "risks": _risks(ir),
    }


def render_summary_text(summary: dict[str, Any]) -> str:
    lines = [
        f"Design: {summary['name']} ({summary['ir_version']})",
        f"Title: {summary.get('title') or '(untitled)'}",
        f"Nets: {summary['nets']['count']} total, grounds={', '.join(summary['nets']['grounds']) or 'none'}",
        "Power rails:",
    ]
    for rail in summary["nets"]["power_rails"]:
        lines.append(f"  - {rail['id']}: {rail.get('nominal_voltage') or 'nominal unknown'}")
    lines.append("Components:")
    for component in summary["components"]:
        part = f" part={component['part']}" if component.get("part") else ""
        lines.append(f"  - {component['id']}: {component['type']}{part}")
    lines.append("Tests:")
    for test in summary["tests"]:
        assertions = ", ".join(assertion["op"] for assertion in test["assertions"]) or "no assertions"
        lines.append(f"  - {test['id']}: {assertions}")
    if summary["risks"]:
        lines.append("Likely risks:")
        for risk in summary["risks"]:
            lines.append(f"  - {risk}")
    return "\n".join(lines) + "\n"


def _risks(ir: SystemIR) -> list[str]:
    risks: list[str] = []
    if not any(net.role == "ground" for net in ir.nets.values()):
        risks.append("No ground net is declared.")
    if any(component.type == "mcu" for component in ir.components.values()) and not ir.firmware_projects:
        risks.append("MCU exists but no firmware project is declared.")
    for iface in ir.interfaces.values():
        if iface.type == "i2c" and "pullup" not in iface.data:
            risks.append(f"I2C interface {iface.id} has no declared pullups.")
    if not ir.tests:
        risks.append("No tests are declared.")
    return risks

