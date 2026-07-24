"""Issue #60 -- the oracle emits REAL ``.model`` cards from a registry model source.

Today a component naming a part-level ``spice_model`` (e.g. ``2N2222``) fails
validation with ``UNDEFINED_SPICE_MODEL`` because ``importer.import_spice_library``
DISCARDS the ``.model`` parameter body and the compiler emits only the generic
builtin cards. This suite pins the fixed behaviour against OBJECTIVE ground truth
captured from the real source (``samples/standard.bjt``) and the local ngspice-46:

  1. the importer captures the FULL 2N2222 card body (params + joined continuation
     lines) with a ``source`` provenance field;
  2. a real 2N2222 BJT-switch design VALIDATES CLEAN (no UNDEFINED_SPICE_MODEL);
  3. ``compile_spice`` emits the real ``.model 2N2222 ...`` card (single joined
     line, real params, byte-stable) and its bytes match the committed oracle
     reference;
  4. discrimination is preserved: ``FOOBAR999`` still errors UNDEFINED_SPICE_MODEL
     and an undefined ``spice_subckt`` still errors;
  5. the fix is a golden-corpus NO-OP (no corpus design references a now-backed
     standard.bjt model, and every corpus ``diagnostics.json`` is unchanged).

Every expected value below is grounded in the pre-fix oracle output and the real
``samples/standard.bjt`` card; the KEY cases (1-3) FAIL on the current code.

Run:
    PYTHONPATH=packages/core/src PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
        python -m pytest tests/test_spice_model_cards.py -v
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from air.parser import parse_string
from air.spice import compile_spice
from air.validation import has_errors, validate_ir, validate_tree

REPO_ROOT = Path(__file__).resolve().parent.parent
STANDARD_BJT = REPO_ROOT / "samples" / "standard.bjt"
DESIGN_DIR = REPO_ROOT / "tests" / "spice_models"
DESIGN = DESIGN_DIR / "bjt_2n2222_switch.air.xml"
EXPECTED_CIR = DESIGN_DIR / "bjt_2n2222_switch.expected.cir"
CORPUS_DIR = REPO_ROOT / "tests" / "golden_corpus"

# The real Gummel-Poon parameters of the 2N2222 card in samples/standard.bjt
# (lines 4-7). These MUST be captured by the importer and emitted in the netlist
# card -- they are the point of the issue. Compared case-insensitively so the
# assertion pins the real DATA, not a canonicalisation choice; the exact bytes are
# pinned separately by the committed oracle reference (test_compile_* below).
REAL_2N2222_PARAMS = (
    "IS=1E-14", "VAF=100", "BF=200", "IKF=0.3", "XTB=1.5", "BR=3",
    "CJC=8E-12", "CJE=25E-12", "TR=100E-9", "TF=400E-12",
    "ITF=1", "VTF=2", "XTF=3", "RB=10", "RC=.3", "RE=.2",
)

# Every BJT model NAME defined in samples/standard.bjt. The fix backs these (and
# only these BJT parts); no golden-corpus design may reference one, or the fix
# would flip that design's diagnostics (guard below).
STANDARD_BJT_NAMES = (
    "2N2222", "2N2907", "2N3904", "2N3906",
    "FZT849", "ZTX1048A", "2N4124", "2N4126", "BC547B",
)


def _diagnostics(xml: str):
    ir, tree = parse_string(xml)
    return validate_tree(tree) + validate_ir(ir)


def _codes(xml: str) -> set[str]:
    return {d.code for d in _diagnostics(xml)}


def _compile_netlist(design: Path) -> str:
    ir, _tree = parse_string(design.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        first_test = next(iter(ir.tests.values()), None)
        compile_spice(ir, Path(tmp), first_test)
        return (Path(tmp) / "spice" / "main.cir").read_text(encoding="utf-8")


def _model_card_line(netlist: str) -> str | None:
    for line in netlist.splitlines():
        if line.startswith(".model 2N2222"):
            return line
    return None


# --------------------------------------------------------------------------- #
# 1. Importer captures the full 2N2222 card body + a source provenance field.  #
#    FAILS pre-fix: the importer stores only {type, spice_model, ...}.          #
# --------------------------------------------------------------------------- #

def test_importer_captures_full_2n2222_card_body_with_source():
    from air.importer import import_spice_library

    with tempfile.TemporaryDirectory() as tmp:
        generated = import_spice_library(STANDARD_BJT, Path(tmp))
        target = next((p for p in generated if p.name.lower() == "2n2222.json"), None)
        assert target is not None, "importer did not emit a 2n2222.json entry"
        data = json.loads(target.read_text(encoding="utf-8"))

    blob = json.dumps(data)
    upper = blob.upper()

    # The parameter body must be captured (not just the model name + type).
    for token in REAL_2N2222_PARAMS:
        assert token.upper() in upper, (
            f"captured 2N2222 entry is missing real parameter {token!r}; "
            f"the importer must capture the full .model card body, got: {blob}"
        )

    # A provenance/source field citing the real source (samples/standard.bjt or
    # the Philips/Linear-Technology vendor).
    assert "source" in data, f"captured entry has no 'source' provenance field: {blob}"
    source_val = json.dumps(data["source"]).lower()
    assert source_val.strip('"'), "the 'source' field is empty"
    assert ("standard.bjt" in upper.lower()) or ("philips" in upper.lower()), (
        f"the 'source' provenance must cite samples/standard.bjt or the vendor, got: {blob}"
    )

    # The continuation lines must be JOINED: no raw SPICE ``+`` continuation
    # survives in the stored card text.
    assert "\n+" not in blob, f"stored card still contains a raw '+' continuation: {blob}"


# --------------------------------------------------------------------------- #
# 2. A real 2N2222 switch design validates clean.                              #
#    FAILS pre-fix: it errors UNDEFINED_SPICE_MODEL.                            #
# --------------------------------------------------------------------------- #

def test_2n2222_design_validates_clean():
    diagnostics = _diagnostics(DESIGN.read_text(encoding="utf-8"))
    codes = {d.code for d in diagnostics}
    assert "UNDEFINED_SPICE_MODEL" not in codes, (
        "the 2N2222 design must be backed by a real .model source and NOT error "
        f"UNDEFINED_SPICE_MODEL; diagnostics: {[(d.severity, d.code) for d in diagnostics]}"
    )
    assert not has_errors(diagnostics), (
        f"the 2N2222 design must validate clean; errors: "
        f"{[(d.severity, d.code, d.message) for d in diagnostics if d.severity == 'error']}"
    )


# --------------------------------------------------------------------------- #
# 3. compile_spice emits the real 2N2222 card (content + byte-exact reference). #
#    FAILS pre-fix: the netlist has no .model 2N2222 line.                      #
# --------------------------------------------------------------------------- #

def test_compile_emits_real_2n2222_card_content():
    netlist = _compile_netlist(DESIGN)
    card = _model_card_line(netlist)
    assert card is not None, (
        "compile_spice emitted no '.model 2N2222 ...' card; the device line "
        "references an undefined model. Netlist:\n" + netlist
    )
    # A single joined line: it opens NPN( and closes ) on the same line.
    assert card.rstrip().endswith(")"), f"the 2N2222 card is not a single closed line: {card!r}"
    assert "NPN(" in card.upper(), f"the 2N2222 card must be an NPN model: {card!r}"
    upper = card.upper()
    for token in REAL_2N2222_PARAMS:
        assert token.upper() in upper, f"emitted 2N2222 card is missing real param {token!r}: {card}"

    # ngspice-46 REJECTS the raw source's non-numeric ``mfg=Philips`` annotation
    # ("Undefined parameter [philips]", verified locally), so the EMITTED card
    # must not carry it (or the micro-verification cannot simulate).
    assert "PHILIPS" not in upper, f"emitted card carries the ngspice-breaking mfg=Philips: {card}"
    assert "MFG=" not in upper, f"emitted card carries a non-SPICE mfg= annotation: {card}"


def test_compile_matches_committed_oracle_reference():
    # Byte-exact contract: the oracle's netlist for this design equals the
    # committed reference (the SAME file the air-ts emitter is diffed against, so
    # air-ts == oracle byte-for-byte). Builder: regenerate the reference with
    # packages/air-ts/scripts/gen-spice-model-refs.py after implementing.
    netlist = _compile_netlist(DESIGN)
    expected = EXPECTED_CIR.read_text(encoding="utf-8")
    assert netlist == expected, (
        "compile_spice output drifted from tests/spice_models/bjt_2n2222_switch.expected.cir.\n"
        "If the fix's canonical card form is intentional, regenerate the reference:\n"
        "  PYTHONPATH=packages/core/src python packages/air-ts/scripts/gen-spice-model-refs.py"
    )


def test_emission_is_deterministic():
    first = _compile_netlist(DESIGN)
    second = _compile_netlist(DESIGN)
    assert first == second, "the same design must compile to byte-identical netlists"


# --------------------------------------------------------------------------- #
# 4. Discrimination preserved (must stay true PRE- and POST-fix).              #
# --------------------------------------------------------------------------- #

_FOOBAR = """<system name="foobar" ir_version="0.1"><metadata><title>t</title></metadata>
<nets><net id="c" role="analog_signal"/><net id="b" role="analog_signal"/><net id="gnd" role="ground"/></nets>
<components><component id="Q1" type="bjt" spice_model="FOOBAR999">
<pin name="C" net="c"/><pin name="B" net="b"/><pin name="E" net="gnd"/></component></components>
<tests/><simulation_profiles/></system>"""

_UNDEF_SUBCKT = """<system name="subx" ir_version="0.1"><metadata><title>t</title></metadata>
<nets><net id="a" role="analog_signal"/><net id="b" role="analog_signal"/><net id="gnd" role="ground"/></nets>
<components><component id="U1" type="diode" spice_subckt="LM358">
<pin name="a" net="a"/><pin name="c" net="b"/></component></components>
<tests/><simulation_profiles/></system>"""


def test_unknown_model_still_errors():
    assert "UNDEFINED_SPICE_MODEL" in _codes(_FOOBAR), (
        "a truly-unknown model (FOOBAR999, not in samples/standard.bjt) must STILL "
        "error UNDEFINED_SPICE_MODEL -- the fix must not weaken discrimination"
    )


def test_undefined_subckt_still_errors():
    assert "UNDEFINED_SPICE_MODEL" in _codes(_UNDEF_SUBCKT), (
        "an undefined spice_subckt (LM358) must STILL error UNDEFINED_SPICE_MODEL -- "
        "this issue backs .model parts, not arbitrary subcircuits"
    )


# --------------------------------------------------------------------------- #
# 5. Golden-corpus guard: the fix changes nothing on the corpus.               #
# --------------------------------------------------------------------------- #

def _corpus_designs() -> list[Path]:
    return sorted(d for d in CORPUS_DIR.iterdir() if (d / "input.air.xml").exists())


def test_no_corpus_design_references_a_backed_standard_bjt_model():
    # The fix backs ONLY the BJT parts in samples/standard.bjt. If a corpus design
    # referenced one, the fix would flip its diagnostics -- confirm none do, so the
    # corpus is provably untouched (its unbacked BSS138/2N7002/LM358/... references
    # stay UNDEFINED).
    offenders = []
    for design in _corpus_designs():
        xml = (design / "input.air.xml").read_text(encoding="utf-8")
        for name in STANDARD_BJT_NAMES:
            if f'"{name}"' in xml:
                offenders.append((design.name, name))
    assert not offenders, (
        f"corpus design(s) reference a now-backed standard.bjt model: {offenders}; "
        "their diagnostics/netlist fixtures would need regeneration (see the PRD)"
    )


def test_corpus_diagnostics_unchanged_by_fix():
    # Byte-exact: for every corpus design, validate_tree+validate_ir serialised the
    # exporter's way must still equal the committed diagnostics.json. A fix that
    # accidentally backed a corpus model (fewer UNDEFINED_SPICE_MODEL errors) would
    # break this. Serialisation mirrors scripts/export_golden.py exactly.
    checked = 0
    for design in _corpus_designs():
        diag_path = design / "diagnostics.json"
        if not diag_path.exists():
            continue
        xml = (design / "input.air.xml").read_text(encoding="utf-8")
        diagnostics = _diagnostics(xml)
        payload = {
            "success": not has_errors(diagnostics),
            "diagnostics": [d.to_dict() for d in diagnostics],
        }
        actual = json.dumps(payload, indent=2, sort_keys=True) + "\n"
        expected = diag_path.read_text(encoding="utf-8")
        assert actual == expected, f"corpus diagnostics changed for {design.name} (fix must be a no-op)"
        checked += 1
    assert checked >= 15, f"expected the full corpus (>= 15 designs), only checked {checked}"


def test_corpus_undefined_model_designs_still_error():
    # The four designs that error UNDEFINED_SPICE_MODEL today (unbacked
    # mosfet/subckt parts) must STILL error after the fix -- direct evidence the
    # backing is narrow (standard.bjt BJTs only).
    still_undefined = []
    for design in _corpus_designs():
        diag_path = design / "diagnostics.json"
        if not diag_path.exists():
            continue
        if "UNDEFINED_SPICE_MODEL" in diag_path.read_text(encoding="utf-8"):
            codes = _codes((design / "input.air.xml").read_text(encoding="utf-8"))
            assert "UNDEFINED_SPICE_MODEL" in codes, (
                f"{design.name} must STILL error UNDEFINED_SPICE_MODEL after the fix"
            )
            still_undefined.append(design.name)
    assert len(still_undefined) >= 4, (
        f"expected >= 4 corpus designs to keep UNDEFINED_SPICE_MODEL, got {still_undefined}"
    )
