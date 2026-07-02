from __future__ import annotations

import json
from pathlib import Path
from xml.etree import ElementTree as ET

from .agent import run_agentic_chat, run_ai_edit, run_ai_generate, run_ai_repair, run_autonomous_repair
from .auto_repair import propose_repair_patch
from .canonicalizer import canonicalize_tree
from .firmware import compile_firmware
from .graph import compile_graph
from .importer import import_spice_library
from .parser import parse_file, parse_tree
from .patches import apply_patch_tree, patch_operations
from .renode import compile_renode
from .repair import build_repair_context
from .runners import build_firmware, run_mixed_signal_check, run_renode
from .simulator import simulate_analog
from .spice import compile_spice
from .validation import has_errors, validate_ir, validate_tree


def validate_design(path: Path) -> dict[str, object]:
    ir, tree = parse_file(path)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    return {"success": not has_errors(diagnostics), "diagnostics": [d.to_dict() for d in diagnostics]}


def save_design(xml_text: str, path: Path) -> dict[str, object]:
    """Persist editor XML to a canonical design file so path-based actions
    (validate/simulate/check/repair) operate on the live design instead of a
    stale on-disk file. Writes even when validation fails so the user can still
    run and see diagnostics; ``success`` reflects validity, not the write."""
    from .normalizer import normalize_air_xml

    try:
        tree = normalize_air_xml(xml_text)
        ir = parse_tree(tree)
    except Exception as exc:
        return {"success": False, "design": str(path), "error": str(exc), "diagnostics": []}
    diagnostics = validate_tree(tree) + validate_ir(ir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonicalize_tree(tree), encoding="utf-8")
    default_profile = next(
        (pid for pid, profile in ir.simulation_profiles.items() if profile.default),
        next(iter(ir.simulation_profiles), "analog_only"),
    )
    return {
        "success": not has_errors(diagnostics),
        "design": str(path),
        "profile": default_profile,
        "diagnostics": [d.to_dict() for d in diagnostics],
    }


def compile_design(path: Path, target: str, out_dir: Path) -> dict[str, object]:
    ir, tree = parse_file(path)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        return {"success": False, "target": target, "artifacts": [], "diagnostics": [d.to_dict() for d in diagnostics]}
    if target == "spice":
        result = compile_spice(ir, out_dir, next(iter(ir.tests.values()), None))
    elif target == "graph":
        result = compile_graph(ir, out_dir / "graph.json")
    elif target == "firmware":
        result = compile_firmware(ir, out_dir)
    elif target == "renode":
        result = compile_renode(ir, out_dir)
    else:
        raise ValueError(f"Unsupported compile target: {target}")
    return {
        "success": result.success,
        "target": result.target,
        "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in result.artifacts],
        "diagnostics": [diagnostic.to_dict() for diagnostic in result.diagnostics],
    }


def simulate_design(path: Path, profile: str, out_dir: Path) -> dict[str, object]:
    ir, tree = parse_file(path)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        return {"success": False, "profile": profile, "status": "failed", "diagnostics": [d.to_dict() for d in diagnostics], "reports": []}
    return simulate_analog(ir, profile, out_dir)


def patch_design(design: Path, patch: Path, out: Path) -> dict[str, object]:
    updated = apply_patch_tree(ET.parse(design), ET.parse(patch))
    ir = parse_tree(updated)
    diagnostics = validate_tree(updated) + validate_ir(ir)
    success = not has_errors(diagnostics)
    if success:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(canonicalize_tree(updated), encoding="utf-8")
    return {"success": success, "out": str(out), "diagnostics": [d.to_dict() for d in diagnostics]}


def patch_preview(design: Path, patch: Path) -> dict[str, object]:
    design_tree = ET.parse(design)
    patch_tree = ET.parse(patch)
    before = validate_tree(design_tree) + validate_ir(parse_tree(design_tree))
    updated = apply_patch_tree(design_tree, patch_tree)
    after = validate_tree(updated) + validate_ir(parse_tree(updated))
    return {
        "success": not has_errors(after),
        "operations": patch_operations(patch_tree),
        "before": _diagnostic_summary(before),
        "after": _diagnostic_summary(after),
        "resolved": _diagnostic_delta(before, after),
        "introduced": _diagnostic_delta(after, before),
    }


def repair_design(design: Path, out: Path, apply_out: Path | None = None, report: Path | None = None) -> dict[str, object]:
    patch_text = propose_repair_patch(design, report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(patch_text, encoding="utf-8")
    result: dict[str, object] = {"success": True, "patch": str(out), "applied": False}
    if apply_out:
        patch_tree = ET.ElementTree(ET.fromstring(patch_text))
        updated = apply_patch_tree(ET.parse(design), patch_tree)
        diagnostics = validate_tree(updated) + validate_ir(parse_tree(updated))
        result["diagnostics"] = [d.to_dict() for d in diagnostics]
        if has_errors(diagnostics):
            result["success"] = False
            return result
        apply_out.parent.mkdir(parents=True, exist_ok=True)
        apply_out.write_text(canonicalize_tree(updated), encoding="utf-8")
        result["applied"] = True
        result["applied_design"] = str(apply_out)
    return result


def check_design(path: Path, profile: str, out_dir: Path) -> dict[str, object]:
    validation = validate_design(path)
    result: dict[str, object] = {"design": str(path), "validation": validation, "compile": None, "simulation": None, "repair_context": None, "status": "passed" if validation["success"] else "failed"}
    if validation["success"]:
        compile_result = compile_design(path, "spice", out_dir)
        result["compile"] = compile_result
        if compile_result["success"]:
            simulation = simulate_design(path, profile, out_dir)
            result["simulation"] = simulation
            result["status"] = simulation["status"]
    if result["status"] != "passed":
        context_path = out_dir / "repair_context.json"
        context_path.parent.mkdir(parents=True, exist_ok=True)
        context_path.write_text(json.dumps(build_repair_context(path), indent=2) + "\n", encoding="utf-8")
        result["repair_context"] = str(context_path)
    result["success"] = result["status"] == "passed"
    return result


def ai_repair_design(design: Path, out: Path, apply_out: Path | None = None, report: Path | None = None, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    return run_ai_repair(design, out, apply_out, report, provider, model)


def ai_generate_design(prompt: str, out: Path, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    return run_ai_generate(prompt, out, provider, model)


def ai_edit_design(current_xml: str, instruction: str, out: Path, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    return run_ai_edit(current_xml, instruction, out, provider, model)


def agentic_chat(message: str, history: list[dict[str, str]], provider: str = "mock", model: str | None = None) -> dict[str, object]:
    return run_agentic_chat(message, history, provider, model)


def build_firmware_design(design: Path, out_dir: Path) -> dict[str, object]:
    return build_firmware(design, out_dir)


def run_renode_design(design: Path, out_dir: Path) -> dict[str, object]:
    return run_renode(design, out_dir)


def run_mixed_signal_design(design: Path, out_dir: Path) -> dict[str, object]:
    return run_mixed_signal_check(design, out_dir)


def run_autonomous_repair_design(design: Path, out_dir: Path, max_iterations: int = 3, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    return run_autonomous_repair(design, out_dir, max_iterations, provider, model)


def import_spice_design(library: Path, out_dir: Path) -> dict[str, object]:
    generated = import_spice_library(library, out_dir)
    return {
        "success": True,
        "generated_count": len(generated),
        "artifacts": [str(p) for p in generated]
    }


def _diagnostic_summary(diagnostics) -> dict[str, object]:
    return {
        "errors": sum(1 for diagnostic in diagnostics if diagnostic.severity == "error"),
        "warnings": sum(1 for diagnostic in diagnostics if diagnostic.severity == "warning"),
        "diagnostics": [diagnostic.to_dict() for diagnostic in diagnostics],
    }


def _diagnostic_delta(left, right) -> list[str]:
    right_keys = {_diagnostic_key(diagnostic) for diagnostic in right}
    return [key for diagnostic in left if (key := _diagnostic_key(diagnostic)) not in right_keys]


def _diagnostic_key(diagnostic) -> str:
    return f"{diagnostic.severity}:{diagnostic.domain}:{diagnostic.code}:{','.join(diagnostic.related_elements)}"
