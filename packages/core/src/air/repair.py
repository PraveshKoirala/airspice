from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .canonicalizer import canonicalize_tree
from .parser import parse_file
from .registry import COMPONENT_SPECS, MCUS
from .validation import validate_ir, validate_tree


def build_repair_context(design_path: Path, report_path: Path | None = None) -> dict[str, Any]:
    ir, tree = parse_file(design_path)
    diagnostics = [diagnostic.to_dict() for diagnostic in validate_tree(tree) + validate_ir(ir)]
    context: dict[str, Any] = {
        "design_path": str(design_path),
        "design_xml": canonicalize_tree(tree),
        "validation_diagnostics": diagnostics,
        "available_registry_components": list(COMPONENT_SPECS.keys()),
        "mcu_registry": list(MCUS.keys()),
        "allowed_patch_ops": ["add", "remove", "replace"],
        "patch_format": {
            "root": "patch",
            "operations": [
                {"op": "replace", "path": "/system/components/component[@id='R_BAT_TOP']/value", "payload": "<value>1.5M</value>"},
                {"op": "add", "path": "/system/components", "payload": "<component id=\"...\" type=\"...\">...</component>"},
                {"op": "remove", "path": "/system/components/component[@id='...']"},
            ],
        },
        "repair_rules": [
            "Only patch design AIR XML.",
            "Do not patch files under generated/.",
            "Prefer the smallest XML patch that resolves diagnostics.",
            "Patch paths must exist unless op is add.",
            "The patched design must validate before simulation.",
        ],
    }
    if report_path:
        context["simulation_report_path"] = str(report_path)
        context["simulation_report"] = json.loads(report_path.read_text(encoding="utf-8"))
    return context

