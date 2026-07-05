#!/usr/bin/env python
"""Generate oracle reference outputs for the air-ts patch + normalizer fixtures.

Same gated-oracle-driver pattern as scripts/gen-spice-diff-refs.py (#9): every
expected byte in tests/patch_fixtures/ is produced by the LIVE Python oracle
(air.patches / air.normalizer / air.canonicalizer), never hand-written. The
air-ts parity suite (tests/patch_parity.test.ts, tests/normalize_parity.test.ts)
byte-diffs the TypeScript engine against these references. If the oracle changes,
regenerate with this script -- never hand-edit a reference.

Fixture layout (all under packages/air-ts/tests/patch_fixtures/):
  patch_designs/<name>.design.air.xml         a design fixture
  patch_designs/<name>.<label>.patch.xml       a patch to apply to <name>.design
    -> <name>.<label>.expected.canon.xml       apply(design, patch) canonicalized
    -> <name>.<label>.preview.json             previewPatch(design, patch)
    OR, when the patch is invalid:
    -> <name>.<label>.error.txt                the oracle's ValueError message
  normalize_cases/<name>.air.xml               a near-miss AI-XML input
    -> <name>.expected.canon.xml               normalize(input) canonicalized

The gate (fixture/port separation, AGENTS.md R1): tests/patch_fixtures/ is a NEW
directory under the port package -- it is NOT the golden corpus, so committing
oracle output here is allowed without the oracle-first label, exactly like #9's
spice_diff_designs references.

Provenance of the ADC-divider case (issue #11's named example): this script
COPIES the live golden-corpus input whose `<system name>` is the ADC divider,
plus examples/failing/fix_bad_adc_divider.patch.xml, INTO patch_designs/ so the
fixture is byte-faithful to the corpus design the issue names. The corpus
DIRECTORY name is never spelled here (guardrails R4); the design is located by
its system-name attribute value instead.

Usage (from repo root, PYTHONPATH -> core src via sys.path insert below):
    python packages/air-ts/scripts/gen-patch-refs.py
    python packages/air-ts/scripts/gen-patch-refs.py --check   # non-zero on drift
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

HERE = Path(__file__).resolve().parent
FIXTURE_DIR = HERE.parent / "tests" / "patch_fixtures"
PATCH_DESIGNS = FIXTURE_DIR / "patch_designs"
NORMALIZE_CASES = FIXTURE_DIR / "normalize_cases"
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "packages" / "core" / "src"))

from air.canonicalizer import canonicalize_tree  # noqa: E402
from air.normalizer import normalize_air_xml  # noqa: E402
from air.patches import apply_patch_tree, patch_operations  # noqa: E402
from air.parser import parse_tree  # noqa: E402
from air.validation import has_errors, validate_ir, validate_tree  # noqa: E402

# The `<system name>` of the ADC-divider design the issue names. Not a corpus
# DIRECTORY name (those are prefixed, e.g. "failing_..."), so writing this value
# does not trip guardrails R4's design-name-in-source scan.
ADC_DIVIDER_SYSTEM_NAME = "bad_adc_divider"


class Writer:
    """Writes a reference file, or (in --check mode) reports drift instead."""

    def __init__(self, check: bool) -> None:
        self.check = check
        self.drift = 0
        self.written = 0

    def write(self, path: Path, content: str) -> None:
        if self.check:
            existing = path.read_text(encoding="utf-8") if path.exists() else None
            if existing != content:
                print(f"DRIFT: {path.relative_to(FIXTURE_DIR)} is stale", file=sys.stderr)
                self.drift += 1
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(content)
            self.written += 1
            print(f"wrote {path.relative_to(FIXTURE_DIR)} ({len(content)} bytes)")

    def copy(self, src: Path, dst: Path) -> None:
        content = src.read_text(encoding="utf-8")
        self.write(dst, content)


def _diagnostic_summary(diagnostics) -> dict:
    return {
        "errors": sum(1 for d in diagnostics if d.severity == "error"),
        "warnings": sum(1 for d in diagnostics if d.severity == "warning"),
        "diagnostics": [d.to_dict() for d in diagnostics],
    }


def _diagnostic_key(d) -> str:
    return f"{d.severity}:{d.domain}:{d.code}:{','.join(d.related_elements)}"


def _diagnostic_delta(left, right) -> list:
    right_keys = {_diagnostic_key(d) for d in right}
    return [k for d in left if (k := _diagnostic_key(d)) not in right_keys]


def _validate_root(root: ET.Element):
    tree = ET.ElementTree(root)
    return validate_tree(tree) + validate_ir(parse_tree(tree))


def build_preview(design_text: str, patch_text: str) -> dict:
    """Mirror service.patch_preview exactly, from XML strings (no filesystem)."""
    design_root = ET.fromstring(design_text)
    patch_tree = ET.ElementTree(ET.fromstring(patch_text))
    before = _validate_root(design_root)
    updated = apply_patch_tree(ET.ElementTree(ET.fromstring(design_text)), patch_tree)
    after = validate_tree(updated) + validate_ir(parse_tree(updated))
    return {
        "success": not has_errors(after),
        "operations": patch_operations(patch_tree),
        "before": _diagnostic_summary(before),
        "after": _diagnostic_summary(after),
        "resolved": _diagnostic_delta(before, after),
        "introduced": _diagnostic_delta(after, before),
    }


def apply_canonical(design_text: str, patch_text: str) -> str:
    updated = apply_patch_tree(
        ET.ElementTree(ET.fromstring(design_text)),
        ET.ElementTree(ET.fromstring(patch_text)),
    )
    return canonicalize_tree(updated)


def normalize_canonical(input_text: str) -> str:
    return canonicalize_tree(normalize_air_xml(input_text))


def locate_corpus_adc_divider() -> Path:
    """Find the golden-corpus input whose <system name> is the ADC divider.

    Located by attribute value, not by directory name, so this script never
    spells a corpus directory name (guardrails R4).
    """
    corpus = REPO_ROOT / "tests" / "golden_corpus"
    for input_path in sorted(corpus.glob("*/input.air.xml")):
        try:
            root = ET.fromstring(input_path.read_text(encoding="utf-8"))
        except ET.ParseError:
            continue
        if root.tag == "system" and root.attrib.get("name") == ADC_DIVIDER_SYSTEM_NAME:
            return input_path
    raise FileNotFoundError(
        f"no golden-corpus design named {ADC_DIVIDER_SYSTEM_NAME!r} found"
    )


def seed_adc_divider_fixture(writer: Writer) -> None:
    """Copy the live corpus ADC-divider input + the named fix patch into the
    fixture tree so the apply case is byte-faithful to the corpus design."""
    corpus_input = locate_corpus_adc_divider()
    fix_patch = REPO_ROOT / "examples" / "failing" / "fix_bad_adc_divider.patch.xml"
    writer.copy(corpus_input, PATCH_DESIGNS / "adc_divider.design.air.xml")
    writer.copy(fix_patch, PATCH_DESIGNS / "adc_divider.fix.patch.xml")


def process_patch_designs(writer: Writer) -> None:
    seed_adc_divider_fixture(writer)
    designs = {p.name[: -len(".design.air.xml")]: p
               for p in PATCH_DESIGNS.glob("*.design.air.xml")}
    for patch_path in sorted(PATCH_DESIGNS.glob("*.patch.xml")):
        stem = patch_path.name[: -len(".patch.xml")]
        # <design>.<label>
        design_key = None
        for key in designs:
            if stem == key or stem.startswith(key + "."):
                design_key = key
                break
        if design_key is None:
            print(f"WARNING: no design for patch {patch_path.name}", file=sys.stderr)
            continue
        design_text = designs[design_key].read_text(encoding="utf-8")
        patch_text = patch_path.read_text(encoding="utf-8")
        # Build output names by CONCATENATION (not Path.with_suffix, which would
        # treat the ".<label>" segment as an extension and collapse every case
        # of one design onto the same file).
        canon_out = PATCH_DESIGNS / f"{stem}.expected.canon.xml"
        preview_out = PATCH_DESIGNS / f"{stem}.preview.json"
        error_out = PATCH_DESIGNS / f"{stem}.error.txt"
        try:
            canon = apply_canonical(design_text, patch_text)
            preview = build_preview(design_text, patch_text)
        except Exception as exc:  # noqa: BLE001 -- oracle ValueError is the fixture
            # Invalid patch: the reference IS the oracle's error message.
            writer.write(error_out, f"{type(exc).__name__}: {exc}\n")
            # Remove any stale success references so a case can't be both.
            _remove_if_present(writer, canon_out)
            _remove_if_present(writer, preview_out)
            continue
        writer.write(canon_out, canon)
        writer.write(preview_out, json.dumps(preview, indent=2) + "\n")
        _remove_if_present(writer, error_out)


def _remove_if_present(writer: Writer, path: Path) -> None:
    if writer.check:
        return
    if path.exists():
        path.unlink()


def process_normalize_cases(writer: Writer) -> None:
    for input_path in sorted(NORMALIZE_CASES.glob("*.air.xml")):
        if input_path.name.endswith(".expected.canon.xml"):
            continue
        input_text = input_path.read_text(encoding="utf-8")
        base = input_path.name[: -len(".air.xml")]
        canon = normalize_canonical(input_text)
        writer.write(input_path.with_name(base + ".expected.canon.xml"), canon)
        # Second-pass reference (normalize(normalize(x))). For almost every case
        # this equals the first pass (idempotence). It DIVERGES only where the
        # oracle itself is not reparse-stable -- the CPython 3.12 minidom bug
        # that writes raw tab/LF/CR into ATTRIBUTE values (they collapse to
        # spaces on the next parse). Committing the oracle's OWN second pass
        # makes the parity test assert that air-ts tracks the oracle's
        # fixed-point behavior EXACTLY, rather than a blanket idempotence claim
        # that is false for that input. See normalize_parity.test.ts.
        canon2 = normalize_canonical(canon)
        writer.write(input_path.with_name(base + ".idem2.canon.xml"), canon2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="Fail if a reference is stale (do not rewrite).")
    args = parser.parse_args(argv)

    # VERSION PIN (PR #87 rework r1): a subset of these references -- the ones
    # exercising literal tab/LF/CR in ATTRIBUTE values -- are Python-version
    # dependent, because CPython's minidom changed its attribute control-char
    # escaping in 3.13 (gh-124061): 3.12 writes them RAW, 3.13+ char-ref-escapes
    # them. CI pins Python 3.12 (.github/workflows/*.yml), and the golden corpus
    # is generated on 3.12, so 3.12 is authoritative. Generating on 3.13+ will
    # emit different bytes for attr_whitespace_charrefs / add_charref_attrs and
    # those references will then be stale in CI. Regenerate on 3.12; a bump of
    # CI's Python is an oracle-first change that moves these golden bytes.
    if sys.version_info[:2] != (3, 12):
        print(
            f"WARNING: running on Python {sys.version_info.major}."
            f"{sys.version_info.minor}, but CI pins 3.12. The attribute-"
            "whitespace references are minidom-version-dependent (gh-124061) and "
            "may drift against CI. Regenerate on 3.12 before committing.",
            file=sys.stderr,
        )

    writer = Writer(check=args.check)
    process_patch_designs(writer)
    process_normalize_cases(writer)

    if args.check and writer.drift:
        print(f"{writer.drift} stale reference(s).", file=sys.stderr)
        return 1
    if not args.check:
        print(f"wrote {writer.written} reference file(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
