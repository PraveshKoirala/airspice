from __future__ import annotations

import json
import re
from pathlib import Path


# A SPICE model parameter value we can emit into a ``.model`` card: a signed
# decimal (optionally with an exponent) followed by an optional SI/unit suffix
# (``800m``, ``100E-9``, ``6.734f``, ``.3``, ``1E-14``). Non-numeric annotations
# such as ``mfg=Philips`` do NOT match -- ngspice rejects them as undefined
# parameters (they would abort the whole netlist), so they are dropped from the
# emitted card and, for ``mfg`` specifically, folded into the ``source``
# provenance instead of being lost.
_NUMERIC_VALUE_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[a-zA-Z]*$")


def import_spice_library(lib_path: Path, out_dir: Path) -> list[Path]:
    if not lib_path.exists():
        raise FileNotFoundError(f"Library file not found: {lib_path}")

    content = lib_path.read_text(encoding="utf-8", errors="ignore")
    # SPICE ``+`` continuation lines are physical-line folds: a ``.model`` card
    # may span several lines, each continuation prefixed with ``+``. Fold them
    # onto the logical line FIRST so the card body (all params) is captured whole
    # -- the pre-fix importer read only the first line and discarded everything
    # after the first newline (issue #60). Mirrors air-ts import/spice.ts
    # `logicalLines`.
    folded = _fold_continuations(content)
    generated = []

    # 1. Parse .MODEL cards -- now capturing the FULL, canonicalized card body.
    # Example (folded): .model 2N2222 NPN(IS=1E-14 VAF=100 BF=200 ... mfg=Philips)
    model_regex = re.compile(
        r"^\.MODEL\s+([^\s(]+)\s+([^\s(]+)(?:\s*\((.*)\))?\s*$",
        re.IGNORECASE | re.MULTILINE,
    )
    for match in model_regex.finditer(folded):
        raw_name = match.group(1)
        raw_type = match.group(2)
        body = match.group(3)  # None when the card has no parenthesised params
        name = raw_name.upper()
        m_type = raw_type.upper()

        comp_type = _map_spice_type(m_type)
        if not comp_type:
            continue

        card, source = _canonical_model_card(raw_name, raw_type, body, lib_path)

        data = {
            "type": comp_type,
            "spice_model": name,
            "required_pins": _pins_for_type(comp_type),
            "spice_supported": True,
            # The REAL, byte-stable ``.model`` card parsed from the source library
            # (whitespace-canonicalized, non-numeric annotations dropped). Its
            # presence is what BACKS a part in validation and lets spice.py emit a
            # ``.model`` for it (issue #60). No hand-typed / fabricated params.
            "spice_card": card,
            # Provenance for the card: the source library file, plus the
            # manufacturer taken from the card's ``mfg=`` annotation when present.
            "source": source,
        }

        out_path = out_dir / f"{name.lower()}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        generated.append(out_path)

    # 2. Parse .SUBCKT lines (unchanged from the pre-#60 behaviour: read over the
    # raw content so subcircuit pin parsing / type-guessing is untouched).
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
            "spice_supported": True,
        }

        out_path = out_dir / f"{name.lower()}.json"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        generated.append(out_path)

    return generated


def _fold_continuations(content: str) -> str:
    """Fold SPICE ``+`` continuation lines onto the preceding logical line.

    A line whose first non-blank character is ``+`` continues the previous
    logical line; the ``+`` and surrounding whitespace collapse to a single
    space. Byte-for-byte the same fold air-ts import/spice.ts performs, so a
    card captured here matches what the TS importer would see.
    """
    out_lines: list[str] = []
    for raw in content.splitlines():
        stripped = raw.strip()
        if stripped.startswith("+"):
            cont = stripped[1:].strip()
            if out_lines:
                out_lines[-1] = f"{out_lines[-1]} {cont}"
            else:
                out_lines.append(cont)
        else:
            out_lines.append(raw)
    return "\n".join(out_lines)


def _canonical_model_card(
    name: str, m_type: str, body: str | None, lib_path: Path
) -> tuple[str, str]:
    """Canonicalize a real ``.model`` card into deterministic, byte-stable text.

    The card is emitted verbatim into every netlist that references the part, so
    it must be a single deterministic form:

    * name/type kept exactly as they appear in the source library,
    * parameters kept in SOURCE ORDER (order is semantically irrelevant to SPICE
      and source order is already deterministic and byte-stable),
    * each parameter rendered ``KEY=VALUE`` with the value verbatim from source
      (no reformatting of ``1E-14`` / ``.3`` / ``800m`` -- these are REAL params),
    * whitespace normalized to single spaces, no space around ``=`` or the parens,
    * parameters whose value is NOT a numeric SPICE quantity are dropped, because
      ngspice aborts on them (e.g. ``mfg=Philips``); the ``mfg`` annotation is
      folded into the returned provenance string instead of being discarded.

    Returns ``(card_text, source)``.
    """
    params: list[str] = []
    mfg: str | None = None
    if body:
        for token in body.split():
            key, sep, value = token.partition("=")
            if not sep:
                # A bare flag token with no value. None appear in the supported
                # source libraries; drop it rather than risk emitting something
                # ngspice cannot parse.
                continue
            if key.lower() == "mfg":
                mfg = value
                continue
            if _NUMERIC_VALUE_RE.match(value):
                params.append(f"{key}={value}")
            # else: a non-numeric annotation ngspice would reject -- drop it.

    card = f".model {name} {m_type}({' '.join(params)})"

    # Provenance: the source library path (forward-slashed for cross-platform
    # byte-stability) plus the manufacturer from the card's ``mfg=`` when present.
    source = str(lib_path).replace("\\", "/")
    if mfg:
        source = f"{source} ({mfg})"
    return card, source


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
