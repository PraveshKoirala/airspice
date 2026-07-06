"""Corpus byte-parity check for the <gui>-schema addition (issue #22 B).

Simulation output requires the pinned ngspice, but the non-simulation fixtures
(canonical.air.xml, model.json, graph.json, diagnostics.json) are pure functions
of the parser+model+serializer+validator. They must be byte-identical before and
after adding <gui>-hint support, because no pre-#22 design carries the hint --
the addition is designed as an omit-when-none / document-order-preserving
extension. This script re-parses every corpus input.air.xml and confirms it.

Run:  python tests/schematic_parity/check_gui_corpus.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "packages" / "core" / "src"))

from air.canonicalizer import canonicalize_tree  # noqa: E402
from air.graph import build_graph_data  # noqa: E402
from air.model_dump import model_to_dict  # noqa: E402
from air.parser import parse_file  # noqa: E402
from air.validation import validate_ir, validate_tree  # noqa: E402


CORPUS = REPO / "tests" / "golden_corpus"


def check_design(design_dir: Path) -> list[str]:
    problems: list[str] = []
    input_path = design_dir / "input.air.xml"
    if not input_path.exists():
        return [f"{design_dir.name}: no input.air.xml"]
    ir, tree = parse_file(input_path)

    canon = canonicalize_tree(tree)
    expected_canon = (design_dir / "canonical.air.xml").read_text(encoding="utf-8")
    if canon != expected_canon:
        problems.append(f"{design_dir.name}: canonical.air.xml differs")

    model_json = json.dumps(model_to_dict(ir), indent=2, sort_keys=True) + "\n"
    expected_model = (design_dir / "model.json").read_text(encoding="utf-8")
    if model_json != expected_model:
        problems.append(f"{design_dir.name}: model.json differs")

    graph = build_graph_data(ir)
    graph_json = json.dumps(graph, indent=2, sort_keys=True) + "\n"
    expected_graph = (design_dir / "graph.json").read_text(encoding="utf-8")
    if graph_json != expected_graph:
        problems.append(f"{design_dir.name}: graph.json differs")

    diagnostics = validate_tree(tree) + validate_ir(ir)
    payload = {
        "success": not any(d.severity == "error" for d in diagnostics),
        "diagnostics": [d.to_dict() for d in diagnostics],
    }
    diag_json = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    expected_diag = (design_dir / "diagnostics.json").read_text(encoding="utf-8")
    if diag_json != expected_diag:
        problems.append(f"{design_dir.name}: diagnostics.json differs")

    return problems


def main() -> int:
    designs = sorted(p for p in CORPUS.iterdir() if p.is_dir())
    checked = 0
    all_problems: list[str] = []
    for design in designs:
        if not (design / "input.air.xml").exists():
            continue
        checked += 1
        all_problems.extend(check_design(design))
    if all_problems:
        for p in all_problems:
            print(f"FAIL {p}")
        return 1
    print(f"ok {checked} designs -- canonical/model/graph/diagnostics all byte-identical")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
