#!/usr/bin/env python
"""Generate oracle reference netlists for the issue-#60 backed-model designs.

For every ``*.air.xml`` design under repo-root ``tests/spice_models/`` this
compiles the design through the LIVE Python oracle (``air.spice.compile_spice``
with the first test, exactly like ``scripts/export_golden.py`` and the sibling
``gen-spice-diff-refs.py``) and writes the resulting ``main.cir`` next to it as
``<name>.expected.cir``.

These designs reference part-level SPICE models that issue #60 backs from
``samples/standard.bjt`` (e.g. the 2N2222 common-emitter switch). The
``.expected.cir`` reference is the byte-exact contract the air-ts emitter and the
Python oracle must BOTH reproduce (``tests/spice_models`` is shared by
``tests/test_spice_model_cards.py`` and
``packages/air-ts/tests/spice_model_card.test.ts``).

IMPORTANT (builder): after implementing issue #60, REGENERATE the references:

    PYTHONPATH=packages/core/src python packages/air-ts/scripts/gen-spice-model-refs.py

The committed reference was seeded by the TEST author from the real
``samples/standard.bjt`` card with the ngspice-incompatible ``mfg=Philips``
annotation stripped (ngspice-46 rejects the non-numeric value ``Philips`` as an
undefined expression -- verified locally). If your emitter's canonical card form
differs (e.g. it also drops the datasheet-only ``Vceo``/``Icrating`` ratings, or
places the card elsewhere), regenerate so the reference is the oracle's ACTUAL
bytes; the air-ts emitter must then match it byte-for-byte (that IS the parity
deliverable).

Usage (from repo root, PYTHONPATH set to core src):
    python packages/air-ts/scripts/gen-spice-model-refs.py
    python packages/air-ts/scripts/gen-spice-model-refs.py --check   # non-zero on drift
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
# packages/air-ts/scripts -> repo root is three levels up.
REPO_ROOT = HERE.parents[2]
DESIGN_DIR = REPO_ROOT / "tests" / "spice_models"
sys.path.insert(0, str(REPO_ROOT / "packages" / "core" / "src"))

from air.parser import parse_file  # noqa: E402
from air.spice import compile_spice  # noqa: E402
from air.validation import has_errors, validate_ir, validate_tree  # noqa: E402


class DesignInvalidError(RuntimeError):
    """A design failed the oracle's validation gate (pre-fix: UNDEFINED_SPICE_MODEL)."""


def oracle_netlist(design: Path) -> str:
    """Compile a design the same way scripts/export_golden.py does.

    Mirrors the exporter's gate: a design with any error-severity diagnostic is
    NOT compiled. Pre-fix, the backed-model designs error with
    UNDEFINED_SPICE_MODEL and this raises loudly (do not regenerate against
    unfixed code); post-fix they validate clean.
    """
    ir, tree = parse_file(design)
    diagnostics = validate_tree(tree) + validate_ir(ir)
    if has_errors(diagnostics):
        errs = [f"{d.code}: {d.message}" for d in diagnostics if d.severity == "error"]
        raise DesignInvalidError(
            f"{design.name} has error-severity diagnostics (the gate would refuse it):\n  "
            + "\n  ".join(errs)
        )
    with tempfile.TemporaryDirectory() as tmp:
        first_test = next(iter(ir.tests.values()), None)
        compile_spice(ir, Path(tmp), first_test)
        return (Path(tmp) / "spice" / "main.cir").read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if a reference is stale.")
    args = parser.parse_args(argv)

    designs = sorted(DESIGN_DIR.glob("*.air.xml"))
    if not designs:
        print(f"no designs found under {DESIGN_DIR}", file=sys.stderr)
        return 1

    drift = 0
    for design in designs:
        netlist = oracle_netlist(design)
        ref = design.with_suffix("").with_suffix(".expected.cir")
        if args.check:
            existing = ref.read_text(encoding="utf-8") if ref.exists() else None
            if existing != netlist:
                print(f"DRIFT: {ref.name} is stale", file=sys.stderr)
                drift += 1
        else:
            with ref.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(netlist)
            print(f"wrote {ref.name} ({len(netlist)} bytes)")

    if args.check and drift:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
