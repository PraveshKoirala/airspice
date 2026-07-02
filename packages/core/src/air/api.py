from __future__ import annotations

from pathlib import Path
from typing import Literal
from .service import (
    agentic_chat,
    ai_repair_design,
    build_firmware_design,
    check_design,
    compile_design,
    import_spice_design,
    patch_design,
    patch_preview,
    repair_design,
    run_autonomous_repair_design,
    run_mixed_signal_design,
    run_renode_design,
    save_design,
    simulate_design,
    validate_design,
    ai_generate_design,
)
from .waveforms import list_waveforms, read_waveform
from .canonicalizer import canonicalize_tree
from .normalizer import normalize_air_xml

from .repair import build_repair_context
from .repair_session import apply_repair_session, start_repair_session

try:
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from pydantic import BaseModel
except ImportError as exc:  # pragma: no cover - exercised only when API deps missing.
    raise RuntimeError("FastAPI dependencies are not installed. Install with: python -m pip install 'air-native-spice[api]'") from exc


app = FastAPI(title="AIR Circuit Platform API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # For development, allow all origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class DesignRequest(BaseModel):
    design: str


class CompileRequest(DesignRequest):
    target: Literal["spice", "firmware", "renode"]
    out_dir: str = "generated"


class SimulateRequest(DesignRequest):
    profile: str = "analog_only"
    out_dir: str = "generated"


class PatchRequest(DesignRequest):
    patch: str
    out: str


class RepairContextRequest(DesignRequest):
    report: str | None = None


class RepairRequest(DesignRequest):
    report: str | None = None
    out: str
    apply_out: str | None = None


class AiRepairRequest(RepairRequest):
    provider: str = "mock"
    model: str | None = None


class RunnerRequest(DesignRequest):
    out_dir: str = "generated"


class RepairSessionStartRequest(DesignRequest):
    provider: str = "mock"
    model: str | None = None
    report: str | None = None
    out_dir: str = "generated/repair_session"


class RepairSessionApplyRequest(DesignRequest):
    patch: str
    out: str
    profile: str = "analog_only"
    out_dir: str = "generated/repair_session_apply"
    simulate: bool = True


class MixedSignalCheckRequest(DesignRequest):
    out_dir: str = "generated/mixed_signal"


class AutonomousRepairRequest(DesignRequest):
    out_dir: str = "generated/autonomous_repair"
    max_iterations: int = 3
    provider: str = "mock"
    model: str | None = None


class ImportSpiceRequest(BaseModel):
    library: str
    out_dir: str = "registry/components"


class AgenticChatRequest(BaseModel):
    message: str
    history: list[dict[str, str]] = []
    provider: str = "mock"
    model: str | None = None


class GraphRequest(BaseModel):
    xml: str


class XmlRequest(BaseModel):
    xml: str


class SaveDesignRequest(BaseModel):
    xml: str
    path: str = "generated/ui_work/design.air.xml"


class AiEditRequest(BaseModel):
    xml: str
    instruction: str
    out: str = "generated/ui_edit/design.air.xml"
    provider: str = "mock"
    model: str | None = None


@app.post("/validate")
def validate(request: DesignRequest) -> dict[str, object]:
    return validate_design(Path(request.design))


@app.post("/validate-xml")
def validate_xml_route(request: GraphRequest) -> dict[str, object]:
    from .parser import parse_string
    from .validation import validate_tree, validate_ir, has_errors
    
    try:
        ir, tree = parse_string(request.xml)
        diagnostics = validate_tree(tree) + validate_ir(ir)
        return {
            "success": not has_errors(diagnostics),
            "diagnostics": [d.to_dict() for d in diagnostics]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/compile")
def compile_route(request: CompileRequest) -> dict[str, object]:
    return compile_design(Path(request.design), request.target, Path(request.out_dir))


@app.post("/simulate")
def simulate(request: SimulateRequest) -> dict[str, object]:
    return simulate_design(Path(request.design), request.profile, Path(request.out_dir))


@app.post("/check")
def check(request: SimulateRequest) -> dict[str, object]:
    return check_design(Path(request.design), request.profile, Path(request.out_dir))


@app.post("/patch-preview")
def patch_preview_route(request: PatchRequest) -> dict[str, object]:
    return patch_preview(Path(request.design), Path(request.patch))


@app.post("/patch")
def patch_route(request: PatchRequest) -> dict[str, object]:
    return patch_design(Path(request.design), Path(request.patch), Path(request.out))


@app.post("/repair-context")
def repair_context(request: RepairContextRequest) -> dict[str, object]:
    return build_repair_context(Path(request.design), Path(request.report) if request.report else None)


@app.post("/repair")
def repair(request: RepairRequest) -> dict[str, object]:
    return repair_design(
        Path(request.design),
        Path(request.out),
        Path(request.apply_out) if request.apply_out else None,
        Path(request.report) if request.report else None,
    )


@app.post("/ai-repair")
def ai_repair(request: AiRepairRequest) -> dict[str, object]:
    return ai_repair_design(
        Path(request.design),
        Path(request.out),
        Path(request.apply_out) if request.apply_out else None,
        Path(request.report) if request.report else None,
        request.provider,
        request.model,
    )


@app.post("/build-firmware")
def build_firmware_route(request: RunnerRequest) -> dict[str, object]:
    return build_firmware_design(Path(request.design), Path(request.out_dir))


@app.post("/run-renode")
def run_renode_route(request: RunnerRequest) -> dict[str, object]:
    return run_renode_design(Path(request.design), Path(request.out_dir))


@app.post("/mixed-signal-check")
def mixed_signal_check(request: MixedSignalCheckRequest) -> dict[str, object]:
    return run_mixed_signal_design(Path(request.design), Path(request.out_dir))


@app.post("/autonomous-repair")
def autonomous_repair(request: AutonomousRepairRequest) -> dict[str, object]:
    return run_autonomous_repair_design(
        Path(request.design),
        Path(request.out_dir),
        request.max_iterations,
        request.provider,
        request.model,
    )


@app.post("/import-spice")
def import_spice_route(request: ImportSpiceRequest) -> dict[str, object]:
    return import_spice_design(Path(request.library), Path(request.out_dir))


@app.post("/agent/chat")
def agent_chat(request: AgenticChatRequest) -> dict[str, object]:
    return agentic_chat(
        message=request.message,
        history=request.history,
        provider=request.provider,
        model=request.model,
    )


@app.post("/graph")
def graph_route(request: GraphRequest) -> dict[str, object]:
    from .parser import parse_string
    from .graph import build_graph_data
    
    try:
        ir, _ = parse_string(request.xml)
        data = build_graph_data(ir)
        return {"success": True, "nodes": data["nodes"], "edges": data["edges"]}
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.post("/save-design")
def save_design_route(request: SaveDesignRequest) -> dict[str, object]:
    return save_design(request.xml, Path(request.path))


@app.post("/agent/edit")
def agent_edit_route(request: AiEditRequest) -> dict[str, object]:
    from .service import ai_edit_design

    return ai_edit_design(request.xml, request.instruction, Path(request.out), request.provider, request.model)


@app.post("/normalize-xml")
def normalize_xml_route(request: XmlRequest) -> dict[str, object]:
    from .parser import parse_tree
    from .validation import has_errors, validate_ir, validate_tree

    try:
        tree = normalize_air_xml(request.xml)
        ir = parse_tree(tree)
        diagnostics = validate_tree(tree) + validate_ir(ir)
        return {
            "success": not has_errors(diagnostics),
            "xml": canonicalize_tree(tree),
            "diagnostics": [diagnostic.to_dict() for diagnostic in diagnostics],
        }
    except Exception as exc:
        return {"success": False, "xml": request.xml, "diagnostics": [], "error": str(exc)}


@app.get("/waveforms")
def waveforms_route(out_dir: str = "generated") -> dict[str, object]:
    return list_waveforms(Path(out_dir))


@app.get("/waveforms/{name}")
def waveform_route(name: str, out_dir: str = "generated") -> dict[str, object]:
    return read_waveform(Path(out_dir), name)


@app.post("/repair-session/start")
def repair_session_start(request: RepairSessionStartRequest) -> dict[str, object]:
    return start_repair_session(
        Path(request.design),
        Path(request.out_dir),
        request.provider,
        Path(request.report) if request.report else None,
        request.model,
    )


@app.post("/repair-session/apply")
def repair_session_apply(request: RepairSessionApplyRequest) -> dict[str, object]:
    return apply_repair_session(
        Path(request.design),
        Path(request.patch),
        Path(request.out),
        request.profile,
        Path(request.out_dir),
        request.simulate,
    )
