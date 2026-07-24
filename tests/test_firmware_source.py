"""Issue #36 - IR ``<firmware><source>`` inline-MicroPython block (Python oracle).

TEST-FIRST / HERMETIC: authored against the PRD contract before any
implementation exists. These tests exercise the REAL engine public API
(``air.parser`` / ``air.canonicalizer`` / ``air.validation``) - no mocks.

==================  THE CONTRACT THE BUILDER MUST MATCH  ==================
IR shape (the new block is an ADDITIONAL child kind under the single
``<firmware>`` element, coexisting with the existing <project>/<binding>/<task>):

    <firmware mcu="U_MCU" language="micropython" entry="main" pins="4,5">
      <source><![CDATA[ ...real MicroPython source... ]]></source>
    </firmware>

Canonical emit:
  * ``<source>`` payload is preserved BYTE-EXACT (no reindent, no trimming, no
    newline normalization beyond the repo LF rule, no dropping of blank lines).
  * On emit the payload is wrapped in ``<![CDATA[ ... ]]>`` (NOT XML-escaped
    text), and any literal ``]]>`` inside the source is split-escaped as the
    sequence ``]]]]><![CDATA[>``.

Declared-pins convention (SANCTIONED SIMPLE DESIGN - no Python static analysis):
  ``pins="GPIO4,GPIO5"`` is a comma-separated manifest of registry pin IDs the
  firmware uses -- the SAME ids used everywhere else in the IR (the
  ``<component id="U_MCU"><pin name="GPIO4"/>`` and ``registry.MCUS[part]["pins"]``
  keys). A declared pin id ``X`` is considered PRESENT on the MCU iff the MCU's
  registry definition defines pin id ``X`` (no bare-number -> GPIO mapping).
  ESP32-C3 defines GPIO0..GPIO5 (+8,9), so ``pins="GPIO4,GPIO5"`` is clean and
  ``pins="GPIO4,GPIO99"`` flags GPIO99. (The MicroPython body still calls
  ``Pin(4)``/``Pin(5)`` -- that's the runtime API, a separate layer.)

Validation diagnostic CODES (severity=error). Per docs/diagnostics_spec.md the
NEW-code namespace scheme is ``PREFIX-###`` (the grandfathered SCREAMING_SNAKE
family does NOT extend to new codes); firmware VALIDATION checks fall in the
``VAL-`` bucket:
  * VAL-001 - ``mcu`` references a component id that does not exist
  * VAL-002 - ``mcu`` references a component whose type != "mcu"
  * VAL-003 - a declared pin id is absent from the MCU registry definition
  (this suite asserts code + severity only.)

Backward compat: existing declarative-task firmware designs (no <source>) parse
and validate UNCHANGED, and emit NONE of the three codes above.
=========================================================================
"""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "core" / "src"))

from air.parser import parse_string, parse_file  # noqa: E402
from air.canonicalizer import canonicalize_tree  # noqa: E402
from air.validation import validate_ir, validate_tree, has_errors  # noqa: E402

# Contract codes (see module docstring): namespaced VAL- validation codes.
VAL_MCU_UNDEFINED = "VAL-001"  # mcu references a missing component
VAL_MCU_NOT_MCU = "VAL-002"  # mcu references a non-MCU component
VAL_PIN_NOT_ON_MCU = "VAL-003"  # a declared pin id is absent from the MCU registry
NEW_FIRMWARE_CODES = {VAL_MCU_UNDEFINED, VAL_MCU_NOT_MCU, VAL_PIN_NOT_ON_MCU}

# Shared, TESTER-authored input designs (byte-identical set consumed by the
# air-ts parity suite in packages/air-ts/tests/firmware_source_parity.test.ts).
# Provenance: hand-authored to encode the PRD #36 contract (the oracle for the
# new block does not yet exist, so these are inputs, not captured oracle output).
FIXTURES = json.loads(
    (ROOT / "packages" / "air-ts" / "tests" / "fixtures" / "firmware_source.json").read_text(
        encoding="utf-8"
    )
)

EXISTING_DECLARATIVE_DESIGN = ROOT / "examples" / "esp32_battery_sensor" / "design.air.xml"


# ----------------------------- helpers (real engine) -----------------------------
def _canonicalize(xml: str) -> str:
    _ir, tree = parse_string(xml)
    return canonicalize_tree(tree)


def _diag_pairs(xml: str) -> set[tuple[str, str]]:
    """(code, severity) pairs from validate_tree + validate_ir over the real engine."""
    ir, tree = parse_string(xml)
    diags = validate_tree(tree) + validate_ir(ir)
    return {(d.code, d.severity) for d in diags}


def _error_codes(xml: str) -> set[str]:
    return {code for code, sev in _diag_pairs(xml) if sev == "error"}


def _source_text(xml: str) -> str:
    """Byte-exact ``<firmware><source>`` payload, extracted engine-agnostically by
    re-parsing (CDATA resolves to text, exactly as ElementTree does)."""
    root = ET.fromstring(xml)
    el = root.find("firmware/source")
    assert el is not None, "design under test must have a <firmware><source> element"
    return el.text or ""


# =============================== parse + canonical ===============================
def test_clean_design_parses_with_source_block() -> None:
    ir, tree = parse_string(FIXTURES["clean_plant_waterer"])
    # The <source> survives parse (raw tree) and carries the real MicroPython body.
    src = tree.getroot().find("firmware/source")
    assert src is not None and "adc.read_u16()" in (src.text or "")


def test_source_canonical_wraps_in_cdata() -> None:
    # RED until the canonicalizer emits CDATA: today it XML-escapes the text and
    # emits no CDATA marker at all.
    canon = _canonicalize(FIXTURES["clean_plant_waterer"])
    assert "<![CDATA[" in canon, "source must be emitted inside a CDATA section"
    # A '<' inside the source must stay literal (in CDATA), never become '&lt;'.
    assert "mv < 1200" in canon
    assert "mv &lt; 1200" not in canon


def test_source_roundtrip_byte_exact_clean() -> None:
    # parse -> canonical emit -> parse must preserve the payload byte-for-byte.
    xml = FIXTURES["clean_plant_waterer"]
    expected = _source_text(xml)
    actual = _source_text(_canonicalize(xml))
    assert actual == expected


def test_escape_torture_roundtrip_byte_exact() -> None:
    # The hard payload: contains ]]>, a tab, trailing spaces, a blank line, '<',
    # '&', and unicode (micro/degree/arrow). RED today because the canonicalizer
    # drops blank lines (its ``if line.strip()`` filter) and does not CDATA-wrap.
    xml = FIXTURES["escape_torture"]
    expected = _source_text(xml)
    # Sanity: the fixture really does carry the torture characters.
    assert "]]>" in expected
    assert "\t" in expected
    assert "\n\n" in expected  # a genuine blank line inside the source
    assert "µ" in expected and "°" in expected and "→" in expected
    assert " \n" in expected  # trailing whitespace before a newline
    actual = _source_text(_canonicalize(xml))
    assert actual == expected


def test_escape_torture_split_cdata_escaping() -> None:
    # RED today: no CDATA, and the ]]> is emitted as ']]&gt;' text.
    canon = _canonicalize(FIXTURES["escape_torture"])
    assert "<![CDATA[" in canon
    # The only correct way to carry ]]> inside CDATA is the split escape.
    assert "]]]]><![CDATA[>" in canon
    # And it must round-trip back to a literal ]]> in the parsed payload.
    assert "]]>" in _source_text(canon)


def test_source_canonicalize_is_idempotent() -> None:
    # Emitting the canonical form and canonicalizing it again is a fixed point.
    xml = FIXTURES["escape_torture"]
    once = _canonicalize(xml)
    twice = _canonicalize(once)
    assert once == twice


# ================================= validation ==================================
def test_bad_mcu_ref_emits_undefined() -> None:
    # mcu="U_NOPE" references a non-existent component.
    assert (VAL_MCU_UNDEFINED, "error") in _diag_pairs(FIXTURES["bad_mcu_ref"])


def test_mcu_pointing_at_non_mcu_emits_not_mcu() -> None:
    # mcu="R_DIV" references a resistor, not an MCU.
    assert (VAL_MCU_NOT_MCU, "error") in _diag_pairs(FIXTURES["mcu_not_mcu"])


def test_declared_pin_absent_from_mcu_emits_pin_not_on_mcu() -> None:
    # pins="GPIO4,GPIO99": GPIO99 is not a pin on the ESP32-C3 registry definition.
    assert (VAL_PIN_NOT_ON_MCU, "error") in _diag_pairs(FIXTURES["bad_pin_not_on_mcu"])


def test_clean_design_has_no_firmware_source_errors() -> None:
    # A valid mcu + valid declared pins must NOT trip any of the new rules, and
    # the design as a whole stays error-free.  (GREEN now and after the fix -
    # guards against a rule that false-positives on a legitimate design.)
    xml = FIXTURES["clean_plant_waterer"]
    assert _error_codes(xml).isdisjoint(NEW_FIRMWARE_CODES)
    ir, tree = parse_string(xml)
    assert not has_errors(validate_tree(tree) + validate_ir(ir))


# =============================== backward compat ===============================
def test_existing_declarative_firmware_unchanged() -> None:
    # The shipped declarative-task firmware design (no <source> block) still
    # parses, still validates clean, keeps its declarative model, and emits NONE
    # of the new firmware-source codes.
    ir, tree = parse_file(EXISTING_DECLARATIVE_DESIGN)
    diags = validate_tree(tree) + validate_ir(ir)
    assert not has_errors(diags)
    codes = {d.code for d in diags}
    assert codes.isdisjoint(NEW_FIRMWARE_CODES)
    # The existing declarative firmware model is intact.
    assert ir.firmware_projects, "declarative <project> must still populate the model"
    assert ir.firmware_tasks, "declarative <task> must still populate the model"


def test_existing_design_canonical_has_no_cdata() -> None:
    # The declarative design has no inline source, so its canonical form must not
    # sprout a CDATA section (the new emit path is source-only).  Guards against
    # the builder perturbing existing golden canonicals.
    canon = canonicalize_tree(parse_file(EXISTING_DECLARATIVE_DESIGN)[1])
    assert "<![CDATA[" not in canon


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
