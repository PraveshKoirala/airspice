from __future__ import annotations

import json
from pathlib import Path

from .artifacts import Artifact, CompileResult
from .model import SystemIR


def build_graph_data(ir: SystemIR) -> dict[str, list[dict[str, object]]]:
    nodes = []
    edges = []
    net_ids = set(ir.nets)
    for component in sorted(ir.components.values(), key=lambda c: c.id):
        pins = [
            {"name": pin.name, "net": pin.net, "function": pin.function or ""}
            for pin in sorted(component.pins.values(), key=lambda p: p.name)
        ]
        nodes.append(
            {
                "id": component.id,
                "type": "component",
                "data": {
                    "label": component.id,
                    "type": component.type,
                    "part": component.part or "",
                    "value": component.value or "",
                    "spice_model": component.spice_model or "",
                    "pins": pins,
                },
            }
        )
        for pin in component.pins.values():
            if not pin.net:
                continue
            net_ids.add(pin.net)
            net_node = f"net:{pin.net}"
            edges.append(
                {
                    "id": f"{component.id}:{pin.name}->{pin.net}",
                    "source": component.id,
                    "target": net_node,
                    "sourceHandle": f"pin:{pin.name}",
                    "targetHandle": "net",
                    "label": pin.name,
                    "data": {"pin": pin.name, "net": pin.net},
                }
            )
    for net_id in sorted(net_ids):
        net = ir.nets.get(net_id)
        role = net.role if net else _infer_net_role(net_id)
        data = {"label": net_id, "role": role}
        if net is None:
            data["implicit"] = True
        nodes.append({"id": f"net:{net_id}", "type": "net", "data": data})
    return {"nodes": nodes, "edges": edges}


def _infer_net_role(net_id: str) -> str:
    normalized = net_id.lower()
    if normalized in {"gnd", "ground", "0", "vss"}:
        return "ground"
    if normalized in {"vcc", "vdd", "vin", "bat", "battery", "3v3", "5v", "+3v3", "+5v"}:
        return "power"
    return "signal"


def compile_graph(ir: SystemIR, out_path: Path) -> CompileResult:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    graph_data = build_graph_data(ir)
    out_path.write_text(json.dumps(graph_data, indent=2) + "\n", encoding="utf-8")
    return CompileResult(target="graph", success=True, artifacts=[Artifact(str(out_path), "graph_json")], diagnostics=[])
