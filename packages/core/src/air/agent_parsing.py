"""Robust, self-verifying extraction of structured artifacts from LLM output.

Design principle: **never trust the model's framing.** A response may arrive as a
JSON envelope (``{"design_xml": "<system ...>"}`` with backslash-escaped quotes),
a fenced ```xml block, a raw top-level element, prose-wrapped XML, or any
combination — and any of those may be malformed. So extraction does not "find a
substring and hope"; it enumerates candidate strings via several strategies and
returns the first one that **actually parses as well-formed XML with the expected
root tag**. Anything that does not parse is rejected, so a caller can rely on the
result being valid XML (or ``None``) — at every agent interaction.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET


def _element_block(text: str, tag: str) -> str | None:
    """First ``<tag ...>...</tag>`` substring (greedy to the last close), or None."""
    match = re.search(rf"<{tag}\b.*</{tag}>", text, re.DOTALL)
    return match.group(0).strip() if match else None


def _well_formed(candidate: str | None, tag: str) -> str | None:
    """Return the candidate's ``<tag>`` block iff it parses as well-formed XML
    with ``tag`` as the root element; otherwise ``None``."""
    if not candidate:
        return None
    block = _element_block(candidate, tag)
    if not block:
        return None
    try:
        root = ET.fromstring(block)
    except ET.ParseError:
        return None
    return block if root.tag == tag else None


def _targeted_unescape(text: str) -> str:
    """Undo the common backslash escapes a model emits when it hands back XML as
    a bare (non-JSON) escaped string. Targeted (not ``unicode_escape``) so we
    never corrupt legitimate unicode."""
    return (
        text.replace('\\"', '"')
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\r", "\r")
        .replace("\\/", "/")
    )


def extract_json_object(text: str | None) -> dict | None:
    """Best-effort parse of a JSON object embedded anywhere in ``text``."""
    if not text:
        return None
    candidates: list[str] = []
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        candidates.append(fenced.group(1))
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        candidates.append(brace.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _json_field_candidates(text: str, keys: tuple[str, ...]) -> list[str]:
    obj = extract_json_object(text)
    if not isinstance(obj, dict):
        return []
    return [obj[key] for key in keys if isinstance(obj.get(key), str)]


def _extract(text: str | None, tag: str, json_keys: tuple[str, ...]) -> str | None:
    """Try every strategy in order; return the first well-formed ``<tag>`` block.

    Order matters: a JSON envelope is decoded first (``json.loads`` un-escapes the
    XML), because a raw regex over the still-escaped envelope text would capture
    ``name=\\"x\\"`` and fail to parse.
    """
    if not text:
        return None
    # 1) JSON envelope field(s) — decoded, hence un-escaped.
    for candidate in _json_field_candidates(text, json_keys):
        found = _well_formed(candidate, tag)
        if found:
            return found
    # 2) The text as-is (covers fenced ```xml blocks and plain top-level XML).
    found = _well_formed(text, tag)
    if found:
        return found
    # 3) Last resort: bare escaped XML not wrapped in JSON.
    if "\\" in text:
        return _well_formed(_targeted_unescape(text), tag)
    return None


def extract_air_design(text: str | None) -> str | None:
    """Return a well-formed AIR ``<system>`` document, or ``None``."""
    return _extract(text, "system", ("design_xml", "xml", "design", "system"))


def extract_air_patch(text: str | None) -> str | None:
    """Return a well-formed AIR ``<patch>`` document, or ``None``."""
    return _extract(text, "patch", ("patch_xml", "patch", "xml"))


_CODE_FENCE = re.compile(r"```(?:c\+\+|cpp|cxx|c|ino|arduino)?\s*(.*?)```", re.DOTALL)


def extract_code(text: str | None) -> str | None:
    """Recover a C/C++ source body from a model response (JSON envelope, fenced
    block, or raw). Returns the source string or ``None``."""
    if not text:
        return None
    obj = extract_json_object(text)
    if isinstance(obj, dict):
        for key in ("main_cpp", "source", "code", "cpp", "firmware"):
            value = obj.get(key)
            if isinstance(value, str) and ("#include" in value or "void " in value or "setup" in value):
                return value.strip()
    fenced = _CODE_FENCE.search(text)
    if fenced and fenced.group(1).strip():
        return fenced.group(1).strip()
    if "#include" in text or "void setup" in text:
        return text.strip()
    return None


def summarize_diagnostics(diagnostics: list[dict], limit: int = 12) -> str:
    """Compact ``CODE: message`` listing for feeding errors back to a model."""
    lines = []
    for diagnostic in diagnostics:
        if diagnostic.get("severity") and diagnostic["severity"] != "error":
            continue
        code = diagnostic.get("code", "ERROR")
        message = diagnostic.get("message", "")
        related = diagnostic.get("related_elements") or []
        suffix = f" (elements: {', '.join(map(str, related))})" if related else ""
        lines.append(f"- {code}: {message}{suffix}")
        if len(lines) >= limit:
            break
    return "\n".join(lines)
