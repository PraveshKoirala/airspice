from __future__ import annotations

from pathlib import Path
import json
import os
from typing import Protocol

from .agent_parsing import extract_air_design, extract_air_patch, extract_code, summarize_diagnostics
from .auto_repair import propose_repair_patch
from .canonicalizer import canonicalize_tree
from .normalizer import normalize_air_xml
from .parser import parse_tree
from .patches import apply_patch_tree
from . import prompts
from .repair import build_repair_context
from .validation import has_errors, validate_ir, validate_tree
import xml.etree.ElementTree as ET


# --------------------------------------------------------------------------- #
# Shared validation helper
# --------------------------------------------------------------------------- #
def validate_design_xml(xml_text: str) -> tuple[bool, list[dict]]:
    """Normalize + parse + validate AIR XML. Returns (ok, diagnostics-as-dicts)."""
    try:
        tree = normalize_air_xml(xml_text)
        ir = parse_tree(tree)
    except Exception as exc:  # malformed XML / structural failure
        return False, [{"severity": "error", "code": "XML_PARSE_ERROR", "message": str(exc)}]
    diagnostics = validate_tree(tree) + validate_ir(ir)
    return (not has_errors(diagnostics), [d.to_dict() for d in diagnostics])


# --------------------------------------------------------------------------- #
# Provider clients
# --------------------------------------------------------------------------- #
class AgentClient(Protocol):
    def propose_patch(self, context: dict[str, object], prior_error: str | None = None) -> str:
        ...

    def generate_design(
        self, prompt: str, registry_context: dict[str, object], prior_error: str | None = None
    ) -> str:
        ...

    def propose_edit_patch(
        self, current_xml: str, instruction: str, prior_error: str | None = None
    ) -> str:
        ...

    def generate_firmware(
        self, hardware_context: str, spec: str, prior_error: str | None = None
    ) -> str:
        ...


_MOCK_FIRMWARE = """#include <Arduino.h>
void setup() { Serial.begin(115200); }
void loop() { Serial.println("mock firmware alive"); delay(1000); }
"""


class MockAgentClient:
    """Deterministic, offline client: rule-based repair and a known-valid design."""

    def __init__(self, design_path: Path, report_path: Path | None = None):
        self.design_path = design_path
        self.report_path = report_path

    def propose_patch(self, context: dict[str, object], prior_error: str | None = None) -> str:
        return propose_repair_patch(self.design_path, self.report_path)

    def generate_design(
        self, prompt: str, registry_context: dict[str, object], prior_error: str | None = None
    ) -> str:
        return prompts.GOLDEN_DESIGN

    def propose_edit_patch(
        self, current_xml: str, instruction: str, prior_error: str | None = None
    ) -> str:
        # Deterministic no-op patch: leaves the (already valid) design unchanged.
        return '<patch id="mock_noop"><reason>mock edit</reason></patch>'

    def generate_firmware(
        self, hardware_context: str, spec: str, prior_error: str | None = None
    ) -> str:
        return _MOCK_FIRMWARE


class OpenAIAgentClient:
    def __init__(self, model: str | None = None):
        try:
            from openai import OpenAI
        except ImportError as exc:
            raise RuntimeError("OpenAI SDK is not installed.") from exc
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        self.client = OpenAI()
        self.model = model or os.environ.get("AIR_OPENAI_MODEL", prompts.DEFAULT_OPENAI_MODEL)

    def _complete(self, system: str, user: str) -> str:
        # Constrain the model to a JSON object so the envelope is reliable; the
        # self-verifying extractor is still the authority on what comes back.
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
        )
        return response.choices[0].message.content or ""

    def generate_design(
        self, prompt: str, registry_context: dict[str, object], prior_error: str | None = None
    ) -> str:
        text = self._complete(
            prompts.generate_system_instruction(registry_context),
            prompts.generate_user_prompt(prompt, prior_error),
        )
        return extract_air_design(text) or ""

    def propose_patch(self, context: dict[str, object], prior_error: str | None = None) -> str:
        text = self._complete(
            "You are a precise circuit-repair engine. Respond with a JSON object whose patch_xml is an AIR <patch> document.",
            prompts.repair_prompt(context, prior_error),
        )
        return extract_air_patch(text) or ""

    def propose_edit_patch(
        self, current_xml: str, instruction: str, prior_error: str | None = None
    ) -> str:
        text = self._complete(
            "You are a precise circuit-edit engine. Respond with a JSON object whose patch_xml is an AIR <patch> diff.",
            prompts.edit_patch_prompt(current_xml, instruction, prior_error),
        )
        return extract_air_patch(text) or ""

    def generate_firmware(
        self, hardware_context: str, spec: str, prior_error: str | None = None
    ) -> str:
        text = self._complete(
            prompts.firmware_system_instruction(),
            prompts.firmware_prompt(hardware_context, spec, prior_error),
        )
        return extract_code(text) or ""


class GeminiAgentClient:
    def __init__(self, model: str | None = None):
        try:
            import google.generativeai as genai
        except ImportError as exc:
            raise RuntimeError("Google Generative AI SDK is not installed.") from exc
        if not os.environ.get("GEMINI_API_KEY"):
            raise RuntimeError("GEMINI_API_KEY is not set.")
        genai.configure(api_key=os.environ["GEMINI_API_KEY"])
        self._model_name = model or os.environ.get("AIR_GEMINI_MODEL", prompts.DEFAULT_GEMINI_MODEL)
        self._genai = genai

    def _complete(self, system: str, user: str) -> str:
        # Force a JSON response so the envelope is well-formed; extraction still
        # self-verifies. Fall back gracefully if a model rejects the mime type.
        model = self._genai.GenerativeModel(self._model_name, system_instruction=system)
        try:
            response = model.generate_content(
                user, generation_config={"response_mime_type": "application/json"}
            )
        except Exception:
            response = model.generate_content(user)
        return response.text or ""

    def generate_design(
        self, prompt: str, registry_context: dict[str, object], prior_error: str | None = None
    ) -> str:
        text = self._complete(
            prompts.generate_system_instruction(registry_context),
            prompts.generate_user_prompt(prompt, prior_error),
        )
        return extract_air_design(text) or ""

    def propose_patch(self, context: dict[str, object], prior_error: str | None = None) -> str:
        text = self._complete(
            "You are a precise circuit-repair engine. Respond with a JSON object whose patch_xml is an AIR <patch> document.",
            prompts.repair_prompt(context, prior_error),
        )
        return extract_air_patch(text) or ""

    def propose_edit_patch(
        self, current_xml: str, instruction: str, prior_error: str | None = None
    ) -> str:
        text = self._complete(
            "You are a precise circuit-edit engine. Respond with a JSON object whose patch_xml is an AIR <patch> diff.",
            prompts.edit_patch_prompt(current_xml, instruction, prior_error),
        )
        return extract_air_patch(text) or ""

    def generate_firmware(
        self, hardware_context: str, spec: str, prior_error: str | None = None
    ) -> str:
        text = self._complete(
            prompts.firmware_system_instruction(),
            prompts.firmware_prompt(hardware_context, spec, prior_error),
        )
        return extract_code(text) or ""


def _make_client(provider: str, model: str | None, design: Path | None, report: Path | None) -> AgentClient:
    if provider == "mock":
        return MockAgentClient(design or Path("."), report)
    if provider == "openai":
        return OpenAIAgentClient(model)
    if provider == "gemini":
        return GeminiAgentClient(model)
    raise ValueError(f"Unknown AI provider: {provider}")


# --------------------------------------------------------------------------- #
# Agent tools (closed-loop + introspection)
# --------------------------------------------------------------------------- #
def get_capabilities() -> dict[str, object]:
    """Returns the list of platform capabilities and supported tools."""
    return {
        "simulation": ["ngspice", "renode", "mixed-signal-check", "lockstep"],
        "validation": ["power-budgeting", "i2c-expert", "pin-assignment", "adc-vref"],
        "import": ["spice-library-importer"],
        "ai": ["autonomous-repair", "from-scratch-generation"],
    }


def list_registry_parts() -> dict[str, object]:
    """Returns the current component and MCU registry content."""
    from .registry import COMPONENT_SPECS, MCUS

    return {"components": list(COMPONENT_SPECS.keys()), "mcus": list(MCUS.keys())}


def run_design_check(design_path: str, out_dir: str = "generated/agent") -> dict[str, object]:
    """Validate a design and run its analog (ngspice) profile.

    This is the fast, conversational check: validation + ngspice only (seconds).
    It deliberately does NOT trigger the full PlatformIO+Renode co-simulation,
    which can take minutes — running that synchronously inside an automatic
    function-calling chat turn made the chat appear to hang indefinitely. Use
    the explicit `mixed-signal-check` CLI/endpoint for the heavy co-sim.
    """
    from . import service

    design = Path(design_path)
    try:
        profile = _default_profile(design)
    except Exception:
        profile = "analog_only"
    return service.check_design(design, profile, Path(out_dir))


def validate_design(design_path: str) -> dict[str, object]:
    """Validate an .air.xml design and return a concise pass/fail with diagnostics."""
    try:
        xml_text = Path(design_path).read_text(encoding="utf-8")
    except OSError as exc:
        return {"valid": False, "error": f"Could not read {design_path}: {exc}"}
    ok, diagnostics = validate_design_xml(xml_text)
    errors = [d for d in diagnostics if d.get("severity") == "error"]
    warnings = [d for d in diagnostics if d.get("severity") == "warning"]
    return {
        "valid": ok,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors[:10],
        "warnings": warnings[:10],
    }


def read_documentation(doc_name: str) -> str:
    """Reads internal documentation from the docs/ directory."""
    safe_name = Path(doc_name).name  # strip any path components
    doc_path = Path("docs") / safe_name
    if not doc_path.exists():
        return f"Error: Documentation {safe_name} not found."
    return doc_path.read_text(encoding="utf-8")


_FIRMWARE_SUFFIXES = {".c", ".cpp", ".cc", ".h", ".hpp", ".ino"}


def write_firmware_file(path: str, content: str) -> str:
    """Writes a C/C++ firmware source or header file under a 'firmware/' directory."""
    base = Path.cwd().resolve()
    target = (base / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
    # Containment: must stay inside the project tree (no .. traversal / absolute escape).
    if base != target and base not in target.parents:
        return "Error: refusing to write outside the project directory."
    if "firmware" not in target.parts:
        return "Error: for safety, files may only be written under a 'firmware' directory."
    if target.suffix.lower() not in _FIRMWARE_SUFFIXES:
        return f"Error: only C/C++ source/header files may be written ({', '.join(sorted(_FIRMWARE_SUFFIXES))})."
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"Successfully wrote {target.relative_to(base)} ({len(content)} bytes)."


AIR_TOOLS = [
    {"name": "get_capabilities", "description": "Inquire what the AINativeSPice platform can do.", "handler": get_capabilities},
    {"name": "list_registry_parts", "description": "List electronics parts and MCUs in the local registry.", "handler": list_registry_parts},
    {"name": "validate_design", "description": "Validate an .air.xml design file and return errors/warnings.", "handler": validate_design},
    {"name": "run_design_check", "description": "Run full validation + simulation on an .air.xml design.", "handler": run_design_check},
    {"name": "read_documentation", "description": "Read internal docs (e.g. 'AIR_SPECIFICATION.md').", "handler": read_documentation},
    {"name": "write_firmware_file", "description": "Create/update C++ firmware source or headers.", "handler": write_firmware_file},
]

_CHAT_TOOLS = [get_capabilities, list_registry_parts, validate_design, run_design_check, read_documentation, write_firmware_file]


# --------------------------------------------------------------------------- #
# Generation (self-healing)
# --------------------------------------------------------------------------- #
def run_ai_generate(prompt: str, out_design: Path, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    from .registry import COMPONENT_SPECS, MCUS

    registry_context = {"components": list(COMPONENT_SPECS.keys()), "mcus": list(MCUS.keys())}

    try:
        client = _make_client(provider, model, None, None)
    except Exception as exc:
        return {"success": False, "provider": provider, "error": str(exc)}

    max_attempts = 1 if provider == "mock" else 3
    prior_error: str | None = None
    design_xml = ""
    diagnostics: list[dict] = []
    valid = False
    attempts = 0

    for attempt in range(max_attempts):
        attempts = attempt + 1
        try:
            design_xml = client.generate_design(prompt, registry_context, prior_error=prior_error)
        except Exception as exc:
            return {"success": False, "provider": provider, "error": str(exc), "attempts": attempts}
        valid, diagnostics = validate_design_xml(design_xml)
        if valid:
            break
        prior_error = summarize_diagnostics(diagnostics)

    out_design.parent.mkdir(parents=True, exist_ok=True)
    out_design.write_text(design_xml, encoding="utf-8")

    return {
        "success": True,  # the call completed and wrote a design
        "provider": provider,
        "design": str(out_design),
        "valid": valid,
        "attempts": attempts,
        "diagnostics": diagnostics,
    }


def run_ai_edit(
    current_xml: str, instruction: str, out_design: Path, provider: str = "mock", model: str | None = None
) -> dict[str, object]:
    """Apply a natural-language change to an existing design via a small AIR
    <patch> diff (cheap to generate) rather than re-emitting the whole design.

    Patch-first for speed; if a valid patch can't be produced/applied within the
    retry budget, fall back to full regeneration so edits never get stuck.
    """
    try:
        client = _make_client(provider, model, None, None)
    except Exception as exc:
        return {"success": False, "provider": provider, "error": str(exc)}

    max_attempts = 1 if provider == "mock" else 3
    prior_error: str | None = None
    candidate_xml = current_xml
    diagnostics: list[dict] = []
    valid = False
    attempts = 0

    for attempt in range(max_attempts):
        attempts = attempt + 1
        try:
            patch_text = client.propose_edit_patch(current_xml, instruction, prior_error=prior_error)
        except Exception as exc:
            prior_error = str(exc)
            continue
        if not patch_text:
            prior_error = "No patch was produced."
            continue
        try:
            updated = apply_patch_tree(
                ET.ElementTree(ET.fromstring(current_xml)), ET.ElementTree(ET.fromstring(patch_text))
            )
            candidate_xml = canonicalize_tree(updated)
        except Exception as exc:
            prior_error = f"Patch did not apply cleanly: {exc}"
            continue
        valid, diagnostics = validate_design_xml(candidate_xml)
        if valid:
            break
        prior_error = summarize_diagnostics(diagnostics)

    if valid:
        out_design.parent.mkdir(parents=True, exist_ok=True)
        out_design.write_text(candidate_xml, encoding="utf-8")
        return {
            "success": True, "provider": provider, "design": str(out_design),
            "valid": True, "attempts": attempts, "mode": "patch", "diagnostics": diagnostics,
        }

    # Fallback: couldn't land a valid patch -> regenerate the full design.
    if provider != "mock":
        fallback_prompt = (
            "Here is an existing AIR design:\n\n" + current_xml
            + "\n\nApply this modification and return the COMPLETE updated design "
            "(keep everything else intact, change only what the request implies):\n" + instruction
        )
        result = run_ai_generate(fallback_prompt, out_design, provider=provider, model=model)
        result["mode"] = "full_regen_fallback"
        result["attempts"] = attempts + int(result.get("attempts", 0))
        return result

    out_design.parent.mkdir(parents=True, exist_ok=True)
    out_design.write_text(candidate_xml, encoding="utf-8")
    return {
        "success": True, "provider": provider, "design": str(out_design),
        "valid": valid, "attempts": attempts, "mode": "patch", "diagnostics": diagnostics,
    }


# --------------------------------------------------------------------------- #
# Custom firmware authoring (compile-in-the-loop)
# --------------------------------------------------------------------------- #
def _hardware_context(ir) -> str:
    """A compact pin/board summary the model needs to write correct firmware."""
    from .firmware import firmware_platformio_settings

    lines: list[str] = []
    mcu = next((c for c in ir.components.values() if c.type == "mcu"), None)
    settings = firmware_platformio_settings(ir)
    if mcu:
        lines.append(f"MCU: {mcu.part}")
    lines.append(f"Board: {settings['board']} (framework {settings['framework']})")
    if mcu:
        lines.append("Pins:")
        for pin in mcu.pins.values():
            func = f", function {pin.function}" if pin.function else ""
            lines.append(f"  {pin.name} -> net '{pin.net}'{func}")
    return "\n".join(lines)


def _tail(text: str, limit: int = 2000) -> str:
    return text[-limit:] if len(text) > limit else text


def run_ai_firmware(
    design: Path, spec: str, out_dir: Path, provider: str = "mock", model: str | None = None,
    max_iterations: int = 3,
) -> dict[str, object]:
    """Author sophisticated custom firmware for a design and compile it, feeding
    compiler errors back to the model until it builds (or the budget is spent).
    This is the real-product loop: hardware design -> bespoke C++ -> binary."""
    from .parser import parse_file
    from .runners import build_firmware_with_source

    ir, _ = parse_file(design)
    context = _hardware_context(ir)
    try:
        client = _make_client(provider, model, None, None)
    except Exception as exc:
        return {"success": False, "provider": provider, "error": str(exc)}

    out_dir.mkdir(parents=True, exist_ok=True)
    prior_error: str | None = None
    code = ""
    built = False
    compiled_attempted = False
    log_tail = ""
    attempts = 0

    for attempt in range(1 if provider == "mock" else max_iterations):
        attempts = attempt + 1
        try:
            code = client.generate_firmware(context, spec, prior_error=prior_error)
        except Exception as exc:
            return {"success": False, "provider": provider, "error": str(exc), "iterations": attempts}
        if not code:
            prior_error = "No firmware source was produced."
            continue
        result = build_firmware_with_source(ir, out_dir / "build", code)
        if result.get("reason") == "no_pio":
            log_tail = "PlatformIO not installed; firmware authored but not compiled."
            break  # can't compile here; return the authored code
        compiled_attempted = True
        built = bool(result.get("built"))
        log_tail = _tail(str(result.get("log", "")), 1500)
        if built:
            break
        prior_error = _tail(str(result.get("log", "")), 2500)

    code_path = out_dir / "main.cpp"
    code_path.write_text(code, encoding="utf-8")
    return {
        "success": True,
        "provider": provider,
        "code_path": str(code_path),
        "compiled": built,
        "compile_attempted": compiled_attempted,
        "iterations": attempts,
        "log_tail": log_tail,
    }


# --------------------------------------------------------------------------- #
# Repair (self-healing)
# --------------------------------------------------------------------------- #
def _apply_patch(design: Path, patch_text: str) -> tuple[ET.ElementTree, list[dict]]:
    updated = apply_patch_tree(ET.parse(design), ET.ElementTree(ET.fromstring(patch_text)))
    ir = parse_tree(updated)
    diagnostics = validate_tree(updated) + validate_ir(ir)
    return updated, [d.to_dict() for d in diagnostics]


def run_ai_repair(
    design: Path,
    out_patch: Path,
    apply_out: Path | None = None,
    report: Path | None = None,
    provider: str = "mock",
    model: str | None = None,
) -> dict[str, object]:
    context = build_repair_context(design, report)
    try:
        client = _make_client(provider, model, design, report)
    except Exception as exc:
        return {"success": False, "provider": provider, "error": str(exc), "patch": str(out_patch), "applied": False, "diagnostics": []}

    max_attempts = 1 if provider == "mock" else 3
    prior_error: str | None = None
    out_patch.parent.mkdir(parents=True, exist_ok=True)
    result: dict[str, object] = {"provider": provider, "patch": str(out_patch), "applied": False, "diagnostics": []}

    for attempt in range(max_attempts):
        result["attempts"] = attempt + 1
        try:
            patch_text = client.propose_patch(context, prior_error=prior_error)
        except Exception as exc:
            return {**result, "success": False, "error": str(exc)}
        patch_text = extract_air_patch(patch_text) or patch_text
        out_patch.write_text(patch_text, encoding="utf-8")

        if not apply_out:
            # Without an apply target we cannot validate; trust the proposal.
            return {**result, "success": True}

        try:
            updated, diagnostics = _apply_patch(design, patch_text)
        except Exception as exc:
            prior_error = f"Patch could not be applied: {exc}"
            result["diagnostics"] = [{"severity": "error", "code": "PATCH_APPLY_ERROR", "message": str(exc)}]
            continue

        result["diagnostics"] = diagnostics
        if not any(d.get("severity") == "error" for d in diagnostics):
            apply_out.parent.mkdir(parents=True, exist_ok=True)
            apply_out.write_text(canonicalize_tree(updated), encoding="utf-8")
            return {**result, "applied": True, "applied_design": str(apply_out), "success": True}

        prior_error = summarize_diagnostics(diagnostics)

    return {**result, "success": False}


# --------------------------------------------------------------------------- #
# Agentic chat (tool-use)
# --------------------------------------------------------------------------- #
def run_agentic_chat(message: str, history: list[dict[str, str]], provider: str = "gemini", model: str | None = None) -> dict[str, object]:
    """Executes an agentic chat turn with tool-use capabilities."""
    if provider == "mock":
        return {"success": True, "response": "I am a mock agent. I see you said: " + message, "history": history + [{"role": "user", "content": message}]}

    if provider != "gemini":
        return {"success": False, "error": f"Unsupported provider: {provider}"}

    try:
        import google.generativeai as genai
    except ImportError:
        return {"success": False, "error": "Google SDK missing"}

    genai.configure(api_key=os.environ.get("GEMINI_API_KEY"))
    chat_model = genai.GenerativeModel(
        model_name=model or os.environ.get("AIR_GEMINI_MODEL", prompts.DEFAULT_GEMINI_MODEL),
        tools=_CHAT_TOOLS,
        system_instruction=prompts.chat_system_instruction(),
    )

    gemini_history = [
        {"role": "user" if entry["role"] == "user" else "model", "parts": [entry["content"]]}
        for entry in history
    ]
    chat = chat_model.start_chat(history=gemini_history, enable_automatic_function_calling=True)
    try:
        response = chat.send_message(message, request_options={"timeout": 120})
        return {
            "success": True,
            "response": response.text,
            "history": history + [{"role": "user", "content": message}, {"role": "assistant", "content": response.text}],
        }
    except Exception as exc:
        return {"success": False, "error": f"Gemini API Error: {exc}", "history": history + [{"role": "user", "content": message}]}


# --------------------------------------------------------------------------- #
# Autonomous repair loop (observable + convergence-aware)
# --------------------------------------------------------------------------- #
def _error_count(diagnostics: list[dict]) -> int:
    return sum(1 for d in diagnostics if d.get("severity") == "error")


def _default_profile(design: Path) -> str:
    from .parser import parse_file

    try:
        ir, _ = parse_file(design)
    except Exception:
        return "analog_only"
    for profile_id, profile in ir.simulation_profiles.items():
        if profile.default:
            return profile_id
    return next(iter(ir.simulation_profiles), "analog_only")


def run_autonomous_repair(design: Path, out_dir: Path, max_iterations: int = 3, provider: str = "mock", model: str | None = None) -> dict[str, object]:
    # Use the validation+analog check (graceful DC fallback) rather than the full
    # mixed-signal check, whose success would require renode/platformio binaries to
    # be installed — otherwise repair could never "succeed" in a tools-light env.
    from .service import check_design

    iterations: list[dict[str, object]] = []
    current_design = design
    last_design_text: str | None = None

    for i in range(max_iterations):
        it_out_dir = out_dir / f"iteration_{i}"
        profile = _default_profile(current_design)
        check_result = check_design(current_design, profile, it_out_dir)

        if check_result.get("success"):
            return {
                "success": True,
                "iterations": iterations,
                "final_design": str(current_design),
                "message": f"All constraints passed after {i} iteration(s).",
            }

        # Pull the first failing report (if analog simulation produced one) for context.
        report_path = None
        simulation = check_result.get("simulation") or {}
        reports = simulation.get("reports") or [] if isinstance(simulation, dict) else []
        if reports:
            first = reports[0]
            report_id = first.get("test") if isinstance(first, dict) else None
            if report_id:
                candidate = it_out_dir / "reports" / f"{report_id}.json"
                report_path = candidate if candidate.exists() else None

        it_patch = it_out_dir / "repair.patch.xml"
        it_fixed = it_out_dir / "fixed.air.xml"
        repair_result = run_ai_repair(current_design, it_patch, apply_out=it_fixed, report=report_path, provider=provider, model=model)

        before_errors = _error_count(repair_result.get("diagnostics", [])) if repair_result.get("diagnostics") else None
        iterations.append({
            "index": i,
            "check_success": check_result.get("success", False),
            "repair_success": repair_result.get("success", False),
            "applied": repair_result.get("applied", False),
            "remaining_errors": before_errors,
            "repair": repair_result,
        })

        if not repair_result.get("success") or not repair_result.get("applied"):
            return {
                "success": False,
                "iterations": iterations,
                "message": f"Repair could not be applied at iteration {i}; stopping.",
            }

        # Convergence: if the patched design is byte-identical to the prior one,
        # we are looping with no effect — stop instead of burning iterations.
        fixed_text = it_fixed.read_text(encoding="utf-8")
        if fixed_text == last_design_text:
            return {
                "success": False,
                "iterations": iterations,
                "message": f"Repair stopped converging at iteration {i} (no change to the design).",
            }
        last_design_text = fixed_text
        current_design = it_fixed

    return {
        "success": False,
        "iterations": iterations,
        "message": f"Failed to resolve all issues after {max_iterations} iterations.",
    }
