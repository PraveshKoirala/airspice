#!/usr/bin/env python
"""Generate oracle reference netlists for the air-ts SPICE differential probes.

For every ``*.air.xml`` design under ``tests/spice_diff_designs/`` this compiles
the design through the LIVE Python oracle (``air.spice.compile_spice`` with the
first test, exactly like ``scripts/export_golden.py``) and writes the resulting
``main.cir`` next to it as ``<name>.expected.cir``.

These are OUR OWN designs (not the golden corpus), so committing the oracle's
output here does not violate the fixture/port separation rule -- it is the
reference side of the #9 differential-probe table, produced by the oracle and
byte-diffed against the air-ts emitter in ``tests/spice_diff.test.ts``.

Usage (from repo root, with the venv active / PYTHONPATH set to core src):
    python packages/air-ts/scripts/gen-spice-diff-refs.py
    python packages/air-ts/scripts/gen-spice-diff-refs.py --check   # non-zero on drift
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESIGN_DIR = HERE.parent / "tests" / "spice_diff_designs"
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "packages" / "core" / "src"))

from air.parser import parse_file  # noqa: E402
from air.spice import compile_spice  # noqa: E402
from air.validation import has_errors, validate_ir, validate_tree  # noqa: E402


class DesignInvalidError(RuntimeError):
    """A differential design failed the oracle's validation gate."""


def oracle_netlist(design: Path) -> str:
    """Compile a design the same way scripts/export_golden.py does.

    Mirrors the exporter's gate: a design with any error-severity diagnostic is
    NOT compiled (its absence would be the expected output). These differential
    designs are all meant to be VALID, so a validation error here is a bug in the
    design, not a fixture -- we raise loudly rather than emit a netlist the real
    pipeline would never produce.
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
