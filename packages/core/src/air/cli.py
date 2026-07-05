from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from xml.etree import ElementTree as ET

from .auto_repair import propose_repair_patch
from .canonicalizer import canonicalize_tree
from .explain import render_summary_text, summarize_design
from .firmware import compile_firmware
from .graph import compile_graph
from .parser import parse_file, parse_string, parse_tree
from .agent import run_ai_repair, run_autonomous_repair
from .importer import import_spice_library
from .patches import apply_patch_tree, patch_operations
from .project import AirProject, load_project, write_project
from .renode import compile_renode
from .repair import build_repair_context
from .repair_session import apply_repair_session, start_repair_session
from .service import ai_generate_design, ai_repair_design, build_firmware_design, check_design, compile_design, patch_design, patch_preview as service_patch_preview, repair_design, run_mixed_signal_design, run_renode_design, simulate_design, validate_design
from .simulator import simulate_analog
from .spice import compile_spice
from .templates import TEMPLATE_NAMES, render_template
from .validation import has_errors, validate_ir, validate_tree


def main(argv: list[str] | None = None) -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
        
    parser = argparse.ArgumentParser(prog="air")
    sub = parser.add_subparsers(dest="command", required=True)

    init_p = sub.add_parser("init", help="Initialize a new AIR project")
    init_p.add_argument("name")
    init_p.add_argument("--template", choices=TEMPLATE_NAMES, default="esp32-battery-sensor")
    init_p.add_argument("--json", action="store_true")

    info_p = sub.add_parser("project-info", help="Display project information")
    info_p.add_argument("--project", default="air.project.json")
    info_p.add_argument("--json", action="store_true")

    validate_p = sub.add_parser("validate", help="Validate a design XML")
    validate_p.add_argument("design")
    validate_p.add_argument("--json", action="store_true")

    summarize_p = sub.add_parser("summarize", help="Summarize a design")
    summarize_p.add_argument("design")
    summarize_p.add_argument("--json", action="store_true")

    dump_model_p = sub.add_parser("dump-model", help="Dump the canonical typed model as deterministic JSON")
    dump_model_p.add_argument("design")
    dump_model_p.add_argument("--json", action="store_true", help="Emit deterministic model JSON (default and only output form)")
    dump_model_p.add_argument("--out", help="Write to this path instead of stdout")

    fuzz_eval_p = sub.add_parser(
        "fuzz-eval",
        help="Machine-readable parse outcome for a single input (differential fuzzing, issue #43)",
    )
    fuzz_eval_p.add_argument(
        "design",
        nargs="?",
        help="Path to the input XML; omit (or pass '-') to read from stdin",
    )
    fuzz_eval_p.add_argument(
        "--stdin", action="store_true", help="Read the input XML from stdin"
    )
    fuzz_eval_p.add_argument(
        "--batch",
        action="store_true",
        help="Stream mode: read length-prefixed inputs from stdin, emit one JSON "
        "outcome line per input (fast path for the differential fuzzer). Each "
        "record is a decimal byte length, a newline, then that many UTF-8 bytes.",
    )

    explain_p = sub.add_parser("explain", help="Explain a design")
    explain_p.add_argument("design")
    explain_p.add_argument("--json", action="store_true")

    template_p = sub.add_parser("generate-template", help="Write a template AIR XML design")
    template_p.add_argument("template", choices=TEMPLATE_NAMES)
    template_p.add_argument("--out", required=True)
    template_p.add_argument("--json", action="store_true")

    compile_p = sub.add_parser("compile", help="Compile a design to target artifacts")
    compile_p.add_argument("design")
    compile_p.add_argument("--target", choices=["spice", "graph", "firmware", "renode"], required=True)
    compile_p.add_argument("--out-dir", default="generated")
    compile_p.add_argument("--json", action="store_true")

    simulate_p = sub.add_parser("simulate", help="Simulate a design")
    simulate_p.add_argument("design")
    simulate_p.add_argument("--profile", default="analog_only")
    simulate_p.add_argument("--out-dir", default="generated")
    simulate_p.add_argument("--json", action="store_true")

    check_p = sub.add_parser("check", help="Run full check (Validate + Simulate)")
    check_p.add_argument("design")
    check_p.add_argument("--profile", default="analog_only")
    check_p.add_argument("--out-dir", default="generated")
    check_p.add_argument("--json", action="store_true")

    repair_p = sub.add_parser("repair", help="Automatically repair a design")
    repair_p.add_argument("design")
    repair_p.add_argument("--out", default="generated/repair.patch.xml")
    repair_p.add_argument("--apply-out")
    repair_p.add_argument("--report")
    repair_p.add_argument("--json", action="store_true")

    patch_preview_p = sub.add_parser("patch-preview", help="Preview a patch effect")
    patch_preview_p.add_argument("design")
    patch_preview_p.add_argument("patch")
    patch_preview_p.add_argument("--json", action="store_true")

    patch_p = sub.add_parser("patch", help="Apply an XML patch")
    patch_p.add_argument("design")
    patch_p.add_argument("patch")
    patch_p.add_argument("--out", required=True)
    patch_p.add_argument("--json", action="store_true")

    repair_context_p = sub.add_parser("repair-context", help="Build AI repair context")
    repair_context_p.add_argument("design")
    repair_context_p.add_argument("--report")
    repair_context_p.add_argument("--out", required=True)
    repair_context_p.add_argument("--json", action="store_true")

    ai_repair_p = sub.add_parser("ai-repair", help="Repair a design using AI provider")
    ai_repair_p.add_argument("design")
    ai_repair_p.add_argument("--provider", default="mock")
    ai_repair_p.add_argument("--model")
    ai_repair_p.add_argument("--report")
    ai_repair_p.add_argument("--out", default="generated/ai.patch.xml")
    ai_repair_p.add_argument("--apply-out")
    ai_repair_p.add_argument("--json", action="store_true")

    gen_p = sub.add_parser("ai-generate", help="Generate a complete design from natural language")
    gen_p.add_argument("prompt")
    gen_p.add_argument("--out", default="generated/generated.air.xml")
    gen_p.add_argument("--provider", default="mock")
    gen_p.add_argument("--model")
    gen_p.add_argument("--json", action="store_true")

    fw_p = sub.add_parser("build-firmware", help="Generate and build firmware")
    fw_p.add_argument("design")
    fw_p.add_argument("--out-dir", default="generated")
    fw_p.add_argument("--json", action="store_true")

    renode_p = sub.add_parser("run-renode", help="Generate and run Renode artifacts")
    renode_p.add_argument("design")
    renode_p.add_argument("--out-dir", default="generated")
    renode_p.add_argument("--json", action="store_true")

    mixed_p = sub.add_parser("mixed-signal-check", help="Run synchronized mixed-signal co-simulation")
    mixed_p.add_argument("design")
    mixed_p.add_argument("--out-dir", default="generated/mixed_signal")
    mixed_p.add_argument("--json", action="store_true")

    import_p = sub.add_parser("import-spice", help="Import SPICE models into the registry")
    import_p.add_argument("library", help="Path to .lib or .mod file")
    import_p.add_argument("--out-dir", default="registry/components", help="Directory to save registry JSONs")
    import_p.add_argument("--json", action="store_true")

    auto_p = sub.add_parser("autonomous-repair", help="Run iterative Simulate -> Diagnose -> Repair loop")
    auto_p.add_argument("design")
    auto_p.add_argument("--out-dir", default="generated/autonomous_repair")
    auto_p.add_argument("--max-iterations", type=int, default=3)
    auto_p.add_argument("--provider", default="mock")
    auto_p.add_argument("--model")
    auto_p.add_argument("--json", action="store_true")

    session_start_p = sub.add_parser("repair-session-start", help="Start an AI repair session")
    session_start_p.add_argument("design")
    session_start_p.add_argument("--provider", default="mock")
    session_start_p.add_argument("--model")
    session_start_p.add_argument("--report")
    session_start_p.add_argument("--out-dir", default="generated/repair_session")
    session_start_p.add_argument("--json", action="store_true")

    session_apply_p = sub.add_parser("repair-session-apply", help="Apply a patch from a session")
    session_apply_p.add_argument("design")
    session_apply_p.add_argument("patch")
    session_apply_p.add_argument("--out", required=True)
    session_apply_p.add_argument("--profile", default="analog_only")
    session_apply_p.add_argument("--out-dir", default="generated/repair_session")
    session_apply_p.add_argument("--no-simulate", action="store_true")
    session_apply_p.add_argument("--json", action="store_true")

    serve_p = sub.add_parser("serve", help="Start the AIR API server")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=8000)

    args = parser.parse_args(argv)

    if args.command == "init":
        return _init_project(Path(args.name), args.template, args.json)
    if args.command == "project-info":
        return _project_info(Path(args.project), args.json)
    if args.command == "validate":
        return _validate(Path(args.design), args.json)
    if args.command in {"summarize", "explain"}:
        return _summarize(Path(args.design), args.json)
    if args.command == "dump-model":
        return _dump_model(Path(args.design), Path(args.out) if args.out else None)
    if args.command == "fuzz-eval":
        if args.batch:
            return _fuzz_eval_batch()
        return _fuzz_eval(args.design, args.stdin)
    if args.command == "generate-template":
        return _generate_template(args.template, Path(args.out), args.json)
    if args.command == "compile":
        return _compile(Path(args.design), args.target, Path(args.out_dir), args.json)
    if args.command == "simulate":
        return _simulate(Path(args.design), args.profile, Path(args.out_dir), args.json)
    if args.command == "check":
        return _check(Path(args.design), args.profile, Path(args.out_dir), args.json)
    if args.command == "repair":
        return _repair(Path(args.design), Path(args.out), args.apply_out, args.report, args.json)
    if args.command == "patch-preview":
        return _patch_preview(Path(args.design), Path(args.patch), args.json)
    if args.command == "patch":
        return _patch(Path(args.design), Path(args.patch), Path(args.out), args.json)
    if args.command == "repair-context":
        return _repair_context(Path(args.design), Path(args.report) if args.report else None, Path(args.out), args.json)
    if args.command == "ai-repair":
        return _ai_repair(Path(args.design), args.provider, args.model, args.report, Path(args.out), args.apply_out, args.json)
    if args.command == "ai-generate":
        return _ai_generate(args.prompt, Path(args.out), args.provider, args.model, args.json)
    if args.command == "build-firmware":
        return _build_firmware(Path(args.design), Path(args.out_dir), args.json)
    if args.command == "run-renode":
        return _run_renode(Path(args.design), Path(args.out_dir), args.json)
    if args.command == "mixed-signal-check":
        return _mixed_signal_check(Path(args.design), Path(args.out_dir), args.json)
    if args.command == "import-spice":
        return _import_spice(Path(args.library), Path(args.out_dir), args.json)
    if args.command == "autonomous-repair":
        return _autonomous_repair(Path(args.design), Path(args.out_dir), args.max_iterations, args.provider, args.model, args.json)
    if args.command == "repair-session-start":
        return _repair_session_start(Path(args.design), args.provider, args.model, Path(args.report) if args.report else None, Path(args.out_dir), args.json)
    if args.command == "repair-session-apply":
        return _repair_session_apply(Path(args.design), Path(args.patch), Path(args.out), args.profile, Path(args.out_dir), not args.no_simulate, args.json)
    if args.command == "serve":
        import uvicorn
        uvicorn.run("air.api:app", host=args.host, port=args.port, reload=True)
        return 0
    return 0


def _init_project(path: Path, template: str, as_json: bool) -> int:
    path.mkdir(parents=True, exist_ok=True)
    design = path / "design.air.xml"
    design.write_text(render_template(template), encoding="utf-8")
    (path / "generated").mkdir(exist_ok=True)
    (path / "patches").mkdir(exist_ok=True)
    project_file = write_project(path, AirProject(name=path.name))
    result = {"success": True, "project": str(path), "design": str(design), "project_file": str(project_file), "template": template}
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Initialized project {path} using template {template}")
    return 0


def _project_info(path: Path, as_json: bool) -> int:
    project, root = load_project(path)
    if as_json:
        data = project.to_dict()
        data["root"] = str(root)
        print(json.dumps(data, indent=2))
    else:
        print(f"Project: {project.name}")
        print(f"Design: {project.design}")
        print(f"Backends: {', '.join(project.enabled_backends)}")
    return 0


def _validate(path: Path, as_json: bool) -> int:
    result = validate_design(path)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Validation", result))
    return 0 if result["success"] else 1


def _summarize(path: Path, as_json: bool) -> int:
    ir, _ = parse_file(path)
    summary = summarize_design(ir)
    print(json.dumps(summary, indent=2) if as_json else render_summary_text(summary))
    return 0


def _dump_model(path: Path, out: Path | None) -> int:
    from .model_dump import model_to_dict

    ir, _ = parse_file(path)
    text = json.dumps(model_to_dict(ir), indent=2, sort_keys=True) + "\n"
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
    else:
        # Write raw bytes so stdout is LF-terminated regardless of platform.
        sys.stdout.write(text)
    return 0


def _fuzz_eval(design: str | None, from_stdin: bool) -> int:
    """Emit a machine-readable parse outcome for a single input (issue #43).

    Reads the input from a path or stdin (path '-' or --stdin), runs the oracle
    fuzz-eval pipeline, and prints one JSON object:
      {"status":"accept","modelHash":"..."} |
      {"status":"reject","codes":[...],"reason":"..."} |
      {"status":"crash","error":"..."}
    Exit code is 0 for accept/reject (both are well-defined outcomes the fuzzer
    compares) and 2 for crash (an unhandled escape the fuzzer must flag).
    """
    from .fuzz_eval import evaluate, evaluate_path

    if from_stdin or design in (None, "-"):
        raw = sys.stdin.buffer.read()
        outcome = evaluate(raw)
    else:
        outcome = evaluate_path(Path(design))
    print(json.dumps(outcome.to_dict(), separators=(",", ":"), sort_keys=True))
    return 2 if outcome.status == "crash" else 0


def _fuzz_eval_batch() -> int:
    """Stream-evaluate length-prefixed inputs from stdin (issue #43 fast path).

    Protocol (binary stdin): each record is a decimal byte length, a newline,
    then exactly that many UTF-8 bytes of input. EOF (or a blank length line)
    ends the stream. For each record, one JSON outcome line is written to stdout
    and flushed, so the differential fuzzer can drive one long-lived oracle
    process instead of spawning Python per case. This is a read-only evaluation
    loop -- no parse behavior differs from single-shot ``fuzz-eval``.
    """
    from .fuzz_eval import evaluate

    stdin = sys.stdin.buffer
    out = sys.stdout
    while True:
        header = stdin.readline()
        if not header:
            break
        line = header.strip()
        if not line:
            break
        try:
            length = int(line)
        except ValueError:
            break
        payload = stdin.read(length)
        outcome = evaluate(payload)
        out.write(json.dumps(outcome.to_dict(), separators=(",", ":"), sort_keys=True))
        out.write("\n")
        out.flush()
    return 0


def _generate_template(template: str, out: Path, as_json: bool) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_template(template), encoding="utf-8")
    result = {"success": True, "template": template, "out": str(out)}
    print(json.dumps(result, indent=2) if as_json else f"Wrote {template} template to {out}")
    return 0


def _compile(path: Path, target: str, out_dir: Path, as_json: bool) -> int:
    result = compile_design(path, target, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text(f"Compile {target}", result))
    return 0 if result["success"] else 1


def _simulate(path: Path, profile: str, out_dir: Path, as_json: bool) -> int:
    result = simulate_design(path, profile, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Simulation", result))
    return 0 if result["success"] else 1


def _check(path: Path, profile: str, out_dir: Path, as_json: bool) -> int:
    result = check_design(path, profile, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Check", result))
    return 0 if result["success"] else 1


def _repair(path: Path, out_patch: Path, apply_out: str | None, report: str | None, as_json: bool) -> int:
    result = repair_design(path, out_patch, Path(apply_out) if apply_out else None, Path(report) if report else None)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Repair", result))
    return 0 if result["success"] else 1


def _patch_preview(path: Path, patch: Path, as_json: bool) -> int:
    result = service_patch_preview(path, patch)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Patch Preview", result))
    return 0 if result["success"] else 1


def _patch(path: Path, patch: Path, out: Path, as_json: bool) -> int:
    result = patch_design(path, patch, out)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Patch", result))
    return 0 if result["success"] else 1


def _repair_context(path: Path, report: Path | None, out: Path, as_json: bool) -> int:
    context = build_repair_context(path, report)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(context, indent=2) + "\n", encoding="utf-8")
    result = {"success": True, "out": str(out)}
    print(json.dumps(result, indent=2) if as_json else f"Wrote repair context to {out}")
    return 0


def _ai_repair(path: Path, provider: str, model: str | None, report: str | None, out_patch: Path, apply_out: str | None, as_json: bool) -> int:
    result = ai_repair_design(path, out_patch, Path(apply_out) if apply_out else None, Path(report) if report else None, provider, model)
    print(json.dumps(result, indent=2) if as_json else _runner_text("AI Repair", result))
    return 0 if result["success"] else 1


def _ai_generate(prompt: str, out: Path, provider: str, model: str | None, as_json: bool) -> int:
    result = ai_generate_design(prompt, out, provider, model)
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"✅ Design generated successfully: {result['design']}")
        else:
            print(f"❌ Design generation failed: {result.get('error')}")
    return 0 if result["success"] else 1


def _build_firmware(design: Path, out_dir: Path, as_json: bool) -> int:
    result = build_firmware_design(design, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Firmware build", result))
    return 0 if result["success"] else 1


def _run_renode(design: Path, out_dir: Path, as_json: bool) -> int:
    result = run_renode_design(design, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Renode run", result))
    return 0 if result["success"] else 1


def _mixed_signal_check(design: Path, out_dir: Path, as_json: bool) -> int:
    result = run_mixed_signal_design(design, out_dir)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Mixed-signal check", result))
    return 0 if result["success"] else 1


def _runner_text(name: str, result: dict[str, object]) -> str:
    success = bool(result.get("success", result.get("status") == "passed"))
    status = "SUCCESS" if success else "FAILED"
    text = f"{name}: {status}\n"
    for diagnostic in result.get("diagnostics", []):
        text += f"  [{diagnostic.get('severity')}] {diagnostic.get('message')}\n"
    return text


def _repair_session_start(design: Path, provider: str, model: str | None, report: Path | None, out_dir: Path, as_json: bool) -> int:
    result = start_repair_session(design, out_dir, provider, report, model)
    print(json.dumps(result, indent=2) if as_json else f"Repair session patch: {result.get('proposal', {}).get('patch')}")
    return 0 if result["success"] else 1


def _repair_session_apply(design: Path, patch: Path, out: Path, profile: str, out_dir: Path, simulate: bool, as_json: bool) -> int:
    result = apply_repair_session(design, patch, out, profile, out_dir, simulate)
    print(json.dumps(result, indent=2) if as_json else _runner_text("Apply Repair", result))
    return 0 if result["success"] else 1


def _import_spice(library: Path, out_dir: Path, as_json: bool) -> int:
    try:
        generated = import_spice_library(library, out_dir)
        result = {
            "success": True,
            "generated_count": len(generated),
            "artifacts": [str(p) for p in generated]
        }
        if as_json:
            print(json.dumps(result, indent=2))
        else:
            print(f"Successfully imported {len(generated)} models from {library.name}")
            for p in generated[:10]:
                print(f"  - {p.relative_to(Path.cwd())}")
            if len(generated) > 10:
                print(f"  ... and {len(generated) - 10} more")
        return 0
    except Exception as e:
        if as_json:
            print(json.dumps({"success": False, "error": str(e)}, indent=2))
        else:
            print(f"Error importing library: {e}", file=sys.stderr)
        return 1


def _autonomous_repair(design: Path, out_dir: Path, max_iterations: int, provider: str, model: str | None, as_json: bool) -> int:
    result = run_autonomous_repair(design, out_dir, max_iterations, provider, model)
    if as_json:
        print(json.dumps(result, indent=2))
    else:
        if result["success"]:
            print(f"✅ Autonomous repair successful! Final design: {result['final_design']}")
        else:
            print(f"❌ Autonomous repair failed. {result['message']}")
        print(f"Iterations completed: {len(result['iterations'])}")
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
