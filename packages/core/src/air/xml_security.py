"""Hostile-XML input gate for the Python oracle (issue #43).

``docs/xml_security.md`` defines a SINGLE binding input contract that BOTH
engines enforce identically: the air-ts port (``packages/air-ts/src/xml.ts``)
and this Python oracle. Untrusted XML reaches both engines through share links
(#27), agent output, and file import (#26); a billion-laughs entity payload or a
1000-deep nesting must be REFUSED before it can do any work, in both engines,
with the same diagnostic code.

CPython's ``xml.etree.ElementTree`` (expat) does NOT expand *external* entities,
but by default it ACCEPTS a ``<!DOCTYPE>`` and EXPANDS *internal* general
entities -- so a self-contained billion-laughs payload detonates in the oracle
unless we gate it. This module is that gate: a pre-parse, count-based check that
never relies on the library's defaults. It is deliberately a byte/character scan
plus a bounded ``iterparse`` element/depth counter -- depth and size are enforced
by COUNTING during a bounded pass, never by catching a stack overflow (issue #43
guardrail).

The limits and codes are the single source of truth shared with air-ts; keep the
two in lockstep. See ``docs/xml_security.md`` for the contract table and the
justification for each numeric limit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# --- Limits (single source of truth; identical to air-ts src/xml.ts) -------- #

MAX_INPUT_BYTES = 5 * 1024 * 1024  # 5 MB (SEC-002)
MAX_DEPTH = 64  # element nesting depth (SEC-003)
MAX_ATTR_COUNT = 256  # attributes on a single element (SEC-004)
MAX_ATTR_VALUE_LEN = 65536  # length of a single attribute value (SEC-005)
MAX_ELEMENT_COUNT = 100_000  # total elements in the document (SEC-006)


# --- Error type ------------------------------------------------------------- #


@dataclass(frozen=True)
class XmlSecurityError(Exception):
    """Raised when input violates the shared XML security contract.

    Carries the registered ``SEC-`` diagnostic ``code`` so callers (the CLI's
    ``fuzz-eval`` mode, the API) can surface a stable, cross-engine identifier,
    not just a message string.
    """

    code: str
    message: str

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.code}: {self.message}"


# --- DOCTYPE / entity declaration gate (SEC-001) ---------------------------- #

# A conservative textual scan is sufficient and is what the air-ts port does:
# in well-formed XML a literal ``<`` cannot appear outside markup, so ``<!DOCTYPE``
# / ``<!ENTITY`` always open a real declaration. We reject on sight -- no
# expansion, ever. Matching is case-sensitive because XML keywords ``DOCTYPE`` /
# ``ENTITY`` are upper-case by the spec; expat rejects lower-case spellings as
# not-well-formed anyway, so those fall through to the parser's own error.
_DOCTYPE_RE = re.compile(r"<!DOCTYPE")
_ENTITY_DECL_RE = re.compile(r"<!ENTITY")


# --- Numeric character reference gate (SEC-008) ----------------------------- #

# Spans where expat does not process character references (mirrors air-ts).
_UNPROCESSED_SPANS_RE = re.compile(
    r"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>"
)
# Syntactically valid numeric char refs only: decimal or lowercase-x hex, but the
# hex digits themselves may be either case (expat accepts &#xD7FF; and &#xd7ff;).
_CHARREF_RE = re.compile(r"&#(?:([0-9]+)|x([0-9a-fA-F]+));")


def _is_xml_char(cp: int) -> bool:
    """XML 1.0 ``Char`` production.

    #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
    """
    return (
        cp == 0x9
        or cp == 0xA
        or cp == 0xD
        or (0x20 <= cp <= 0xD7FF)
        or (0xE000 <= cp <= 0xFFFD)
        or (0x10000 <= cp <= 0x10FFFF)
    )


def _reject_invalid_char_refs(text: str) -> None:
    """Reject numeric char refs to XML-1.0-invalid code points (SEC-008).

    Expat rejects these as "reference to invalid character number"; the check is
    already native in expat, so on the oracle this gate is defensive parity with
    air-ts (which must reproduce expat's decision in front of fast-xml-parser).
    We run it anyway so both engines reach the SAME ``SEC-008`` code rather than
    expat's raw ParseError, keeping the differential outcome comparable.
    """
    scannable = _UNPROCESSED_SPANS_RE.sub("", text)
    for m in _CHARREF_RE.finditer(scannable):
        cp = int(m.group(1), 10) if m.group(1) is not None else int(m.group(2), 16)
        if not _is_xml_char(cp):
            raise XmlSecurityError(
                "SEC-008",
                f"reference to invalid character number: {m.group(0)}",
            )


# --- Encoding gate (SEC-007) ------------------------------------------------ #

# UTF-8 (with an optional BOM) only. UTF-16/UTF-32 inputs -- a hostile share
# link can be any encoding -- are refused. We detect the well-known BOMs and any
# XML declaration whose ``encoding=`` is not a UTF-8 spelling.
_UTF16_LE_BOM = b"\xff\xfe"
_UTF16_BE_BOM = b"\xfe\xff"
_UTF32_LE_BOM = b"\xff\xfe\x00\x00"
_UTF32_BE_BOM = b"\x00\x00\xfe\xff"
_UTF8_BOM = b"\xef\xbb\xbf"

_ENCODING_DECL_RE = re.compile(rb"""<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']""")
_UTF8_NAMES = {"utf-8", "utf8"}


def enforce_encoding(raw: bytes) -> str:
    """Enforce the UTF-8-only encoding policy and decode to text (SEC-007).

    A BOM is tolerated for UTF-8 and stripped. UTF-16/UTF-32 BOMs are refused
    outright. A declared ``encoding=`` that is not UTF-8 is refused. Bytes that
    are not valid UTF-8 are refused. Returns the decoded ``str`` on success.
    """
    # UTF-32 must be checked before UTF-16 (the UTF-32-LE BOM starts with the
    # UTF-16-LE BOM bytes).
    if raw.startswith(_UTF32_LE_BOM) or raw.startswith(_UTF32_BE_BOM):
        raise XmlSecurityError("SEC-007", "UTF-32 input is not permitted (UTF-8 only)")
    if raw.startswith(_UTF16_LE_BOM) or raw.startswith(_UTF16_BE_BOM):
        raise XmlSecurityError("SEC-007", "UTF-16 input is not permitted (UTF-8 only)")

    body = raw[len(_UTF8_BOM):] if raw.startswith(_UTF8_BOM) else raw

    decl = _ENCODING_DECL_RE.search(body[:512])
    if decl is not None:
        name = decl.group(1).decode("ascii", errors="replace").strip().lower()
        if name not in _UTF8_NAMES:
            raise XmlSecurityError(
                "SEC-007", f"declared encoding '{name}' is not permitted (UTF-8 only)"
            )
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise XmlSecurityError(
            "SEC-007", f"input is not valid UTF-8: {exc}"
        ) from exc


# --- Structural count gate (SEC-002..SEC-006) ------------------------------- #


def _enforce_structure(text: str) -> None:
    """Enforce size, depth, element-count, attribute count/length caps.

    Depth and element count are enforced by COUNTING via a bounded ``iterparse``
    walk (never by catching a RecursionError), exactly as the issue requires.
    ``iterparse`` streams start/end events, so depth is a running counter and the
    element total is bounded as we go -- the walk stops the instant a cap is
    exceeded, so a hostile 1000-deep or million-element document cannot exhaust
    memory before we notice.
    """
    byte_len = len(text.encode("utf-8"))
    if byte_len > MAX_INPUT_BYTES:
        raise XmlSecurityError(
            "SEC-002", f"input exceeds {MAX_INPUT_BYTES}-byte limit ({byte_len} bytes)"
        )

    # A bounded structural walk. We use expat directly (via ElementTree's
    # iterparse) but discard the built tree and cap every counter, so this is a
    # measurement pass, not the real parse. Malformed XML raises ParseError here;
    # we let that propagate as a (non-security) parse error to the caller, which
    # classifies it as a normal reject -- identical accept/reject decision to the
    # real parse that follows.
    import xml.etree.ElementTree as ET

    depth = 0
    element_count = 0
    # iterparse needs a stream; wrap the text.
    import io

    source = io.StringIO(text)
    parser_events = ET.iterparse(source, events=("start", "end"))
    for event, elem in parser_events:
        if event == "start":
            depth += 1
            element_count += 1
            if depth > MAX_DEPTH:
                raise XmlSecurityError(
                    "SEC-003", f"nesting depth exceeds {MAX_DEPTH}"
                )
            if element_count > MAX_ELEMENT_COUNT:
                raise XmlSecurityError(
                    "SEC-006", f"element count exceeds {MAX_ELEMENT_COUNT}"
                )
            attrib = elem.attrib
            if len(attrib) > MAX_ATTR_COUNT:
                raise XmlSecurityError(
                    "SEC-004",
                    f"element <{elem.tag}> has {len(attrib)} attributes "
                    f"(limit {MAX_ATTR_COUNT})",
                )
            for value in attrib.values():
                if len(value) > MAX_ATTR_VALUE_LEN:
                    raise XmlSecurityError(
                        "SEC-005",
                        f"attribute value on <{elem.tag}> exceeds "
                        f"{MAX_ATTR_VALUE_LEN} characters",
                    )
        else:  # end
            depth -= 1
            elem.clear()  # free memory as we go; this is a measurement pass


class XmlParseRejection(Exception):
    """Raised for malformed XML surfaced by the security pre-scan.

    The structural walk uses expat, which rejects malformed input during the
    measurement pass. We surface that as a distinct, non-security rejection so
    the differential harness classifies it as an ordinary parse reject (matching
    air-ts's ``XmlParseError``) rather than a crash.
    """


def enforce_xml_security(raw: bytes | str) -> str:
    """Apply the full XML security contract to raw input; return decoded text.

    Order (fail fast, cheapest first):
      1. encoding (SEC-007) -- decode bytes to text, refusing non-UTF-8.
      2. DOCTYPE / entity declarations (SEC-001) -- reject outright, no expansion.
      3. invalid numeric char refs (SEC-008).
      4. size / depth / element-count / attribute caps (SEC-002..006) via a
         bounded counting walk.

    Raises ``XmlSecurityError`` (with a ``SEC-`` code) for any contract
    violation, or ``XmlParseRejection`` for malformed XML detected during the
    structural walk. Returns the decoded, contract-satisfying text on success.
    """
    if isinstance(raw, bytes):
        text = enforce_encoding(raw)
    else:
        text = raw

    if _DOCTYPE_RE.search(text):
        raise XmlSecurityError("SEC-001", "DOCTYPE declarations are not permitted")
    if _ENTITY_DECL_RE.search(text):
        raise XmlSecurityError("SEC-001", "entity declarations are not permitted")

    _reject_invalid_char_refs(text)

    import xml.etree.ElementTree as ET

    try:
        _enforce_structure(text)
    except ET.ParseError as exc:
        raise XmlParseRejection(str(exc)) from exc

    return text
