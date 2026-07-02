from __future__ import annotations

from pathlib import Path

from .agent import run_ai_repair
from .repair import build_repair_context
from .service import check_design, patch_design, patch_preview


def start_repair_session(
    design: Path,
    out_dir: Path,
    provider: str = "mock",
    report: Path | None = None,
    model: str | None = None,
) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    patch_path = out_dir / "proposed.patch.xml"
    proposal = run_ai_repair(design, patch_path, None, report, provider, model)
    result: dict[str, object] = {
        "success": proposal.get("success", False),
        "design": str(design),
        "provider": provider,
        "context": build_repair_context(design, report),
        "proposal": proposal,
        "preview": None,
    }
    if proposal.get("success"):
        result["preview"] = patch_preview(design, patch_path)
    return result


def apply_repair_session(
    design: Path,
    patch: Path,
    out: Path,
    profile: str = "analog_only",
    out_dir: Path | None = None,
    simulate: bool = True,
) -> dict[str, object]:
    patched = patch_design(design, patch, out)
    result: dict[str, object] = {"patch": str(patch), "patched": patched, "simulation": None}
    if patched["success"] and simulate:
        result["simulation"] = check_design(out, profile, out_dir or out.parent / "generated")
        result["success"] = result["simulation"]["status"] == "passed"
    else:
        result["success"] = patched["success"]
    return result

