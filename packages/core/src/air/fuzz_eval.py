"""Oracle harness for differential fuzzing (issue #43).

``air fuzz-eval`` reports a single input's parse outcome in a small, stable,
machine-readable shape so the differential fuzzer (scripts/fuzz_diff.mjs) can
compare it against air-ts's ``parseOutcome`` (packages/air-ts/src/outcome.ts):

  - ``accept``: parsing succeeded; carries a stable FNV-1a-64 hash of the
    serialized model (the canonical ``model.json`` bytes) so two accepts can be
    compared without shipping the whole model.
  - ``reject``: the input was refused; carries the registered SEC- diagnostic
    codes (for security-contract violations) and a human-readable reason.
  - ``crash``: an UNEXPECTED exception escaped the parse pipeline -- a fuzzer
    finding regardless of whether the two engines agree.

The model hash is computed over the EXACT bytes ``dump-model`` writes
(``json.dumps(model_to_dict(ir), indent=2, sort_keys=True) + "\\n"``, with
CPython's default ``ensure_ascii=True``); air-ts's ``serializeModel`` reproduces
those bytes and hashes them with the same FNV-1a-64, so equal models hash equal
across the two engines.

This is a READ-ONLY evaluation wrapper: it changes no parse behavior. The only
behavior change in this PR is the hostile-input security gate in
``xml_security.py`` (documented oracle-first); ``fuzz-eval`` just reports the
outcome that gate + the parser produce.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .xml_security import (
    XmlSecurityError,
    XmlParseRejection,
    enforce_xml_security,
)


# FNV-1a 64-bit constants (identical to air-ts fnv1a64).
_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_MASK64 = 0xFFFFFFFFFFFFFFFF


def fnv1a64(text: str) -> str:
    """FNV-1a 64-bit hash of a string's UTF-8 bytes, hex-encoded (16 chars).

    Byte-for-byte identical to air-ts's ``fnv1a64`` so model hashes are directly
    comparable between the two engines. Deterministic, dependency-free.
    """
    h = _FNV_OFFSET
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * _FNV_PRIME) & _MASK64
    return format(h, "016x")


@dataclass(frozen=True)
class FuzzOutcome:
    """A normalized parse outcome. Exactly one of the payload fields is set."""

    status: str  # "accept" | "reject" | "crash"
    model_hash: str = ""
    codes: tuple[str, ...] = ()
    reason: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        if self.status == "accept":
            return {"status": "accept", "modelHash": self.model_hash}
        if self.status == "reject":
            return {
                "status": "reject",
                "codes": list(self.codes),
                "reason": self.reason,
            }
        return {"status": "crash", "error": self.error}


def _model_json(ir: Any) -> str:
    """Serialize a SystemIR to the byte-exact ``model.json`` string.

    Reproduces ``dump-model`` (and the golden exporter) EXACTLY: sorted keys,
    ``indent=2``, a trailing newline, and CPython's default ``ensure_ascii``.
    """
    from .model_dump import model_to_dict

    return json.dumps(model_to_dict(ir), indent=2, sort_keys=True) + "\n"


def evaluate(raw: bytes | str) -> FuzzOutcome:
    """Evaluate one input through the full oracle pipeline; never raises.

    Pipeline: security gate (xml_security) -> parse (parser.parse_string) ->
    model serialize. Expected refusals (security violations, malformed XML, a
    non-<system> root / structural parse errors) become ``reject``; anything
    else that escapes is a ``crash`` the fuzzer must flag.
    """
    import xml.etree.ElementTree as ET

    # Decode + apply the shared security contract first, so a security violation
    # is reported with its SEC- code exactly as air-ts reports it.
    try:
        text = enforce_xml_security(raw)
    except XmlSecurityError as exc:
        return FuzzOutcome(
            status="reject",
            codes=(exc.code,),
            reason=f"XmlSecurityError: {exc.message}",
        )
    except XmlParseRejection as exc:
        # Malformed XML surfaced by the security pre-scan's counting walk: an
        # ordinary parse reject (air-ts reports the same via XmlParseError), no
        # dedicated code.
        return FuzzOutcome(
            status="reject", codes=(), reason=f"XmlParseError: {exc}"
        )

    # The security gate already ran; parse the (now trusted-shape) text. We call
    # the parser stages directly rather than parse_string so the gate is not run
    # a second time and so a structural/parse ValueError is classified as a
    # reject, not a crash.
    from .parser import parse_tree

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        return FuzzOutcome(
            status="reject", codes=(), reason=f"XmlParseError: {exc}"
        )
    try:
        ir = parse_tree(ET.ElementTree(root))
        model_json = _model_json(ir)
    except ValueError as exc:
        # e.g. "AIR document root must be <system>" and other structural
        # refusals the parser raises deliberately -> a reject, mirroring
        # air-ts's AirParseError.
        return FuzzOutcome(
            status="reject", codes=(), reason=f"AirParseError: {exc}"
        )
    except Exception as exc:  # noqa: BLE001 - deliberate: any other escape = crash
        return FuzzOutcome(
            status="crash", error=f"{type(exc).__name__}: {exc}"
        )

    return FuzzOutcome(status="accept", model_hash=fnv1a64(model_json))


def evaluate_path(path: Path) -> FuzzOutcome:
    """Evaluate the input file at ``path`` (raw bytes, so the encoding gate runs)."""
    return evaluate(Path(path).read_bytes())
