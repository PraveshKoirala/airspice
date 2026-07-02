from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import subprocess
import json
import csv

from .diagnostics import DiagnosticBuilder
from .firmware import compile_firmware
from .parser import parse_file
from .renode import compile_renode
from .simulator import (
    SignalStats,
    prepare_renode_feedback,
    simulate_analog,
    run_ngspice,
    _evaluate_assertions,
    _read_ngspice_waveforms_explicit,
)
from .spice import compile_spice
from .tools import ngspice_path, platformio_path, renode_path
from .validation import has_errors, validate_ir, validate_tree
from .units import parse_quantity, format_quantity

# Hard ceilings so an external toolchain can never hang the process (or an
# automatic function-calling chat turn) indefinitely. PlatformIO builds can
# legitimately take ~1 min on a cold cache; Renode runs from a .resc that must
# self-quit — if it doesn't, this bounds the wait instead of blocking forever.
PIO_BUILD_TIMEOUT_S = 300
RENODE_RUN_TIMEOUT_S = 180


def _run_tool(cmd: list[str], cwd: Path | None, timeout_s: int) -> subprocess.CompletedProcess | None:
    """Run an external tool with a hard timeout. Returns None on timeout."""
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        return None


def build_firmware_with_source(ir, out_dir: Path, main_cpp: str) -> dict[str, object]:
    """Scaffold the PlatformIO project, drop in *custom* main.cpp, and build it.

    Returns {built, returncode, log} (log is the compiler output, used to feed
    errors back into the firmware-generation retry loop). reason='no_pio' when
    the toolchain is absent."""
    from .firmware import compile_firmware

    compile_firmware(ir, out_dir)  # platformio.ini + headers + (placeholder) main
    src = out_dir / "firmware" / "src" / "main.cpp"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(main_cpp, encoding="utf-8")

    platformio = platformio_path()
    if not platformio:
        return {"built": False, "reason": "no_pio", "log": "PlatformIO not installed."}
    result = _run_tool([platformio, "run"], out_dir / "firmware", PIO_BUILD_TIMEOUT_S)
    if result is None:
        log = f"PlatformIO build timed out after {PIO_BUILD_TIMEOUT_S}s."
        (out_dir / "firmware" / "platformio-build.log").write_text(log, encoding="utf-8")
        return {"built": False, "reason": "timeout", "returncode": None, "log": log}
    log = result.stdout + result.stderr
    (out_dir / "firmware" / "platformio-build.log").write_text(log, encoding="utf-8")
    return {"built": result.returncode == 0, "returncode": result.returncode, "log": log}


def build_firmware(design: Path, out_dir: Path) -> dict[str, object]:
    ir, tree = parse_file(design)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        return {"success": False, "diagnostics": [d.to_dict() for d in diagnostics], "artifacts": []}
    compile_result = compile_firmware(ir, out_dir)
    platformio = platformio_path()
    if not platformio:
        builder = DiagnosticBuilder()
        diagnostic = builder.make(
            "warning",
            "platformio",
            "PLATFORMIO_NOT_INSTALLED",
            "PlatformIO is not installed; firmware artifacts were generated but not built.",
            suggested_actions=["Install PlatformIO", "Run python -m pip install platformio", "Build generated/firmware manually"],
        )
        return {
            "success": False,
            "compiled": True,
            "built": False,
            "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts],
            "diagnostics": [diagnostic.to_dict()],
        }
    result = _run_tool([platformio, "run"], out_dir / "firmware", PIO_BUILD_TIMEOUT_S)
    log_path = out_dir / "firmware" / "platformio-build.log"
    if result is None:
        log_path.write_text(f"PlatformIO build timed out after {PIO_BUILD_TIMEOUT_S}s.", encoding="utf-8")
        return {
            "success": False,
            "compiled": True,
            "built": False,
            "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts] + [{"path": str(log_path), "kind": "report"}],
            "diagnostics": [DiagnosticBuilder().make("error", "platformio", "PLATFORMIO_TIMEOUT", f"PlatformIO build exceeded {PIO_BUILD_TIMEOUT_S}s and was aborted.").to_dict()],
            "returncode": None,
        }
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    return {
        "success": result.returncode == 0,
        "compiled": True,
        "built": result.returncode == 0,
        "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts] + [{"path": str(log_path), "kind": "report"}],
        "diagnostics": [],
        "returncode": result.returncode,
    }


def run_renode(design: Path, out_dir: Path, feedback_commands: list[str] | None = None) -> dict[str, object]:
    ir, tree = parse_file(design)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        return {"success": False, "diagnostics": [d.to_dict() for d in diagnostics], "artifacts": []}
    compile_result = compile_renode(ir, out_dir, feedback_commands=feedback_commands)
    renode = renode_path()
    if not renode:
        builder = DiagnosticBuilder()
        diagnostic = builder.make(
            "warning",
            "renode",
            "RENODE_NOT_INSTALLED",
            "Renode is not installed; placeholder Renode artifacts were generated but not executed.",
            suggested_actions=["Install Renode", "Review generated/renode/platform.repl and run.resc"],
        )
        return {
            "success": False,
            "compiled": True,
            "ran": False,
            "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts],
            "diagnostics": [diagnostic.to_dict()],
        }
    result = _run_tool([renode, str(out_dir / "renode" / "run.resc")], None, RENODE_RUN_TIMEOUT_S)
    log_path = out_dir / "renode" / "renode-run.log"
    if result is None:
        log_path.write_text(f"Renode run timed out after {RENODE_RUN_TIMEOUT_S}s (run.resc may not self-quit).", encoding="utf-8")
        return {
            "success": False,
            "compiled": True,
            "ran": False,
            "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts] + [{"path": str(log_path), "kind": "report"}],
            "diagnostics": [DiagnosticBuilder().make("error", "renode", "RENODE_TIMEOUT", f"Renode run exceeded {RENODE_RUN_TIMEOUT_S}s and was aborted.").to_dict()],
            "returncode": None,
        }
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    return {
        "success": result.returncode == 0,
        "compiled": True,
        "ran": result.returncode == 0,
        "artifacts": [{"path": artifact.path, "kind": artifact.kind} for artifact in compile_result.artifacts] + [{"path": str(log_path), "kind": "report"}],
        "diagnostics": [],
        "returncode": result.returncode,
    }


def run_mixed_signal_check(design: Path, out_dir: Path) -> dict[str, object]:
    ir, tree = parse_file(design)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        return {"success": False, "diagnostics": [d.to_dict() for d in diagnostics], "artifacts": []}

    profile = next(iter(ir.simulation_profiles.values()), None)
    mode = profile.properties.get("co_sim_mode", "serial") if profile else "serial"

    if mode == "lockstep":
        return _run_lockstep_check(ir, design, out_dir)

    # 1. Analog Simulation with Stimulus
    analog_result = simulate_analog(ir, "mixed_signal" if "mixed_signal" in ir.simulation_profiles else next(iter(ir.simulation_profiles)), out_dir)

    # 2. Firmware Build
    fw_result = build_firmware(design, out_dir)

    # 3. Co-Simulation (Renode with Analog Feedback)
    reports = []
    for report in analog_result.get("reports", []):
        test = ir.tests[report["test"]]
        feedback = prepare_renode_feedback(ir, test, out_dir)
        renode_result = run_renode(design, out_dir, feedback_commands=feedback)
        reports.append({
            "test": test.id,
            "analog": report,
            "renode": renode_result,
        })

    return {
        "success": all(r["analog"]["status"] == "passed" and r["renode"]["success"] for r in reports),
        "reports": reports,
    }


def _lockstep_probe_net(ir, test) -> str | None:
    """Net whose analog voltage is fed back into the digital side each slice."""
    for bridge in ir.bridges:
        if bridge.type == "adc":
            source = bridge.data.get("analog_source", {})
            if isinstance(source, dict) and source.get("net"):
                return source["net"]
    for assertion in test.assertions:
        if assertion.get("op") == "assert_voltage" and assertion.get("net"):
            return assertion["net"]
    return None


def _run_lockstep_check(ir, design: Path, out_dir: Path) -> dict[str, object]:
    """Time-sliced analog/digital co-simulation.

    Each slice runs a real ngspice transient whose final node voltages are read
    back from the waveform CSVs and carried into the next slice as initial
    conditions (``.ic``). The MCU stimulus comes from the firmware task's GPIO
    operations (the same translation used by the normal analog run), so the loop
    is driven by real generated firmware behaviour — not a hardcoded value. When
    Renode is installed, each slice also feeds the measured analog samples into
    the emulated MCU; otherwise the digital side is reported as not stepped.
    """
    profile = next(iter(ir.simulation_profiles.values()))
    test = ir.tests[profile.tests[0]]
    total_duration = parse_quantity(test.duration, "s") if test.duration else 0.0
    step_duration = parse_quantity(profile.properties.get("time_step", "1ms"), "s")
    if step_duration <= 0:
        step_duration = total_duration or 1e-3
    if total_duration <= 0:
        total_duration = step_duration

    ngspice_available = bool(ngspice_path())
    renode_available = bool(renode_path())
    probe_net = _lockstep_probe_net(ir, test)

    # Build firmware once up front (shared across slices).
    build_firmware(design, out_dir)

    initial_conditions: dict[str, float] = {}
    history: list[dict[str, object]] = []
    current_time = 0.0
    step_idx = 0

    while current_time < total_duration - 1e-12:
        slice_len = min(step_duration, total_duration - current_time)
        slice_test = replace(test, duration=f"{slice_len:.9g}s")

        # 1. Compile + run a real transient for this slice, carrying state forward.
        compile_spice(
            ir,
            out_dir,
            slice_test,
            initial_conditions=initial_conditions or None,
            extra_probes=[probe_net] if probe_net else None,
        )
        ran = (
            run_ngspice(out_dir / "spice" / "main.cir", out_dir / "reports" / f"lockstep_step_{step_idx}.log")
            if ngspice_available
            else False
        )

        # 2. Read the actual probe voltage back and carry it as the next IC.
        value: float | None = None
        if ran and probe_net:
            stats = _read_ngspice_waveforms_explicit(out_dir / "waveforms", slice_test, [probe_net])
            if probe_net in stats:
                value = stats[probe_net].final
                initial_conditions[probe_net] = value

        # 3. Optionally step the digital side with the real analog feedback.
        renode_ran = False
        if renode_available and probe_net:
            feedback = prepare_renode_feedback(ir, slice_test, out_dir)
            renode_result = run_renode(design, out_dir, feedback_commands=feedback)
            renode_ran = bool(renode_result.get("ran"))

        history.append(
            {
                "time_s": current_time,
                "net": probe_net,
                "value": format_quantity(value, "V") if value is not None else None,
                "ngspice_ran": ran,
                "renode_ran": renode_ran,
            }
        )
        current_time += slice_len
        step_idx += 1

    # Evaluate the design's assertion against the final tracked value.
    final_value = initial_conditions.get(probe_net) if probe_net else None
    diagnostics = []
    if final_value is not None and probe_net:
        measured = {probe_net: final_value}
        stats = {probe_net: SignalStats(final_value, final_value, final_value, 0.0, 0.0, "V")}
        diagnostics = _evaluate_assertions(test, measured, stats)

    analog_ran = any(entry["ngspice_ran"] for entry in history)
    digital_ran = any(entry["renode_ran"] for entry in history)
    status = "passed" if analog_ran and not diagnostics else "incomplete" if not analog_ran else "failed"

    if not analog_ran:
        message = (
            f"ngspice not installed; lockstep generated firmware and {len(history)} "
            "per-slice netlists but did not execute the analog transients."
        )
    else:
        digital_note = (
            f" with Renode digital feedback on '{probe_net}'"
            if digital_ran
            else " (Renode not installed; digital side not stepped)"
        )
        message = (
            f"Lockstep tracked '{probe_net}' across {len(history)} ngspice transient "
            f"slices of {format_quantity(step_duration, 's')} with state hand-off{digital_note}."
        )

    return {
        "success": status == "passed",
        "mode": "lockstep",
        "status": status,
        "ngspice_available": ngspice_available,
        "renode_available": renode_available,
        "steps_completed": len(history),
        "time_step": format_quantity(step_duration, "s"),
        "tracked_net": probe_net,
        "final_value": format_quantity(final_value, "V") if final_value is not None else None,
        "history_preview": history[:5],
        "diagnostics": [d.to_dict() for d in diagnostics],
        "message": message,
    }
