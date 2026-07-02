from __future__ import annotations

import json
import re
from pathlib import Path


def import_spice_library(lib_path: Path, out_dir: Path) -> list[Path]:
    if not lib_path.exists():
        raise FileNotFoundError(f"Library file not found: {lib_path}")
    
    content = lib_path.read_text(encoding="utf-8", errors="ignore")
    generated = []

    # 1. Parse .MODEL lines
    # Example: .MODEL 2N2222 NPN (IS=...)
    model_regex = re.compile(r"^\.MODEL\s+([^\s\(]+)\s+([^\s\(]+)", re.IGNORECASE | re.MULTILINE)
    for match in model_regex.finditer(content):
        name = match.group(1).upper()
        m_type = match.group(2).upper()
        
        comp_type = _map_spice_type(m_type)
        if not comp_type:
            continue
            
        data = {
            "type": comp_type,
            "spice_model": name,
            "required_pins": _pins_for_type(comp_type),
            "spice_supported": True
        }
        
        out_path = out_dir / f"{name.lower()}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        generated.append(out_path)

    # 2. Parse .SUBCKT lines
    # Example: .SUBCKT LM358 1 2 3 4 5
    subckt_regex = re.compile(r"^\.SUBCKT\s+([^\s\(]+)\s+(.+)$", re.IGNORECASE | re.MULTILINE)
    for match in subckt_regex.finditer(content):
        name = match.group(1).upper()
        pins_str = match.group(2).strip()
        pins = pins_str.split()
        
        # Try to guess type from name or comments
        comp_type = _guess_subckt_type(name, content, match.start())
        
        data = {
            "type": comp_type or "generic",
            "spice_subckt": name,
            "required_pins": pins,
            "spice_supported": True
        }
        
        out_path = out_dir / f"{name.lower()}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        generated.append(out_path)

    return generated


def _map_spice_type(m_type: str) -> str | None:
    m_type = m_type.upper()
    if m_type in {"NPN", "PNP"}:
        return "bjt"
    if m_type in {"D"}:
        return "diode"
    if m_type in {"NMOS", "PMOS"}:
        return "mosfet"
    if m_type in {"NJF", "PJF"}:
        return "jfet"
    return None


def _pins_for_type(comp_type: str) -> list[str]:
    if comp_type == "bjt":
        return ["C", "B", "E"]
    if comp_type == "diode":
        return ["a", "c"]
    if comp_type == "mosfet":
        return ["D", "G", "S"]
    return ["1", "2"]


def _guess_subckt_type(name: str, content: str, pos: int) -> str | None:
    # Look for keywords in the comments preceding the subcircuit
    snippet = content[max(0, pos-500):pos].upper()
    if "OPAMP" in snippet or "OPERATIONAL AMPLIFIER" in snippet:
        return "opamp"
    if "REGULATOR" in snippet or "LDO" in snippet:
        return "ldo"
    if "MOSFET" in snippet:
        return "mosfet"
    
    # Check name heuristics
    name = name.upper()
    if "LM" in name or "OPA" in name or "AD" in name:
        return "opamp"
    
    return None
