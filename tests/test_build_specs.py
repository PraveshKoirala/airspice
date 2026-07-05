"""Build-benchmark spec corpus validation (issue #106 + #107).

Loads every spec under ``packages/agent/bench/build_specs/specs/*.json`` and, for
each spec that ships a ``golden`` reference, runs the golden design through the
SAME objective, machine-checkable criteria the child-C scorer (#107) runs:

* required_components   — component types + counts (+ optional part)
* connectivity          — the structural predicate vocabulary in the corpus README
* firmware_intent       — declarative firmware ops bound to the right pins/nets
* erc_clean             — no validation errors
* sim_assertion         — the named net simulates into [min_v, max_v] on ngspice

A golden that fails its OWN spec's criteria fails the suite loudly — that is the
whole point: it proves the criteria are satisfiable and not mis-specified (a spec
whose golden cannot pass its own criteria is a broken spec, per issue #106 and
AGENTS.md's prime directive).

The scorer's criteria evaluation lives in ``air.build_score`` (issue #107): the
predicate solver + criteria checks #106 wrote were lifted VERBATIM into that
shared module so BOTH this golden test AND the #107 build harness call the SAME
code — there is no divergent fork of the objective scorer. This module imports
that code and asserts every golden PASSES its own criteria, BOTH via the
individual checks AND via the harness's top-level ``score_build`` orchestrator.

The connectivity predicates are pure structural checks on the parsed AIR model
(net/pin graph) — no LLM judge. Placeholder tokens like ``<sense>`` in the spec
are UNIFIED: a placeholder that appears in several predicates (or in
sim_assertion) must resolve to the same net across all of them, which is how "the
divider tap is the ADC net" is checked objectively.

Run (needs real ngspice on PATH or AIR_NGSPICE):

    PYTHONPATH=packages/core/src python -m pytest tests/test_build_specs.py -v
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from air.build_score import (
    Design,
    Unifier,
    check_firmware_intent,
    check_required_components,
    evaluate_connectivity,
    resolve_mcu_part,
    score_build,
)
from air.parser import parse_file
from air.simulator import simulate_analog
from air.tools import ngspice_path
from air.units import parse_quantity
from air.validation import has_errors, validate_ir, validate_tree


REPO_ROOT = Path(__file__).resolve().parent.parent
SPECS_DIR = REPO_ROOT / "packages" / "agent" / "bench" / "build_specs" / "specs"
BUILD_SPECS_ROOT = REPO_ROOT / "packages" / "agent" / "bench" / "build_specs"

VALID_MCU_KEYS = {"esp32_c3", "esp32_wroom_32", "stm32_f103", "atmega328"}
VALID_FIDELITY = {"faithful", "abstracted"}
VALID_PRIMITIVES = {"voltage_source", "resistor_divider", "generic_load"}


# ---------------------------------------------------------------------------
# Spec loading
# ---------------------------------------------------------------------------

def _load_specs() -> list[dict]:
    specs = []
    for path in sorted(SPECS_DIR.glob("*.json")):
        specs.append(json.loads(path.read_text(encoding="utf-8")))
    return specs


ALL_SPECS = _load_specs()
SPEC_IDS = [s["id"] for s in ALL_SPECS]
GOLDEN_SPECS = [s for s in ALL_SPECS if s.get("golden")]
GOLDEN_IDS = [s["id"] for s in GOLDEN_SPECS]


def test_corpus_has_enough_specs() -> None:
    assert 30 <= len(ALL_SPECS) <= 45, (
        f"issue #106 asks for 30-40 specs; found {len(ALL_SPECS)}."
    )


def test_spec_ids_unique() -> None:
    assert len(SPEC_IDS) == len(set(SPEC_IDS)), "spec ids must be unique"


@pytest.mark.parametrize("spec", ALL_SPECS, ids=SPEC_IDS)
def test_spec_schema_wellformed(spec: dict) -> None:
    """Every spec is schema-complete and internally consistent (no sim needed)."""
    for key in ("id", "title", "category", "prompt", "mcu", "fidelity", "criteria", "turn_budget"):
        assert key in spec, f"{spec.get('id')}: missing top-level key {key!r}"
    assert spec["mcu"] in VALID_MCU_KEYS, f"{spec['id']}: bad mcu {spec['mcu']!r}"
    assert spec["fidelity"] in VALID_FIDELITY, f"{spec['id']}: bad fidelity {spec['fidelity']!r}"
    assert isinstance(spec["turn_budget"], int) and spec["turn_budget"] >= 1

    if spec["fidelity"] == "abstracted":
        abstraction = spec.get("abstraction")
        assert isinstance(abstraction, dict), f"{spec['id']}: abstracted spec must carry an abstraction block"
        assert abstraction.get("primitive") in VALID_PRIMITIVES, (
            f"{spec['id']}: abstraction.primitive {abstraction.get('primitive')!r} not one of {VALID_PRIMITIVES}"
        )
        assert abstraction.get("part") and abstraction.get("reason")
    else:
        assert "abstraction" not in spec, (
            f"{spec['id']}: faithful specs must NOT carry an abstraction block"
        )

    crit = spec["criteria"]
    for key in ("required_components", "connectivity", "firmware_intent", "erc_clean"):
        assert key in crit, f"{spec['id']}: criteria missing {key!r}"
    assert crit["erc_clean"] is True, f"{spec['id']}: erc_clean must be true"
    assert isinstance(crit["required_components"], list) and crit["required_components"]
    for rc in crit["required_components"]:
        assert rc.get("type") and isinstance(rc.get("count"), int)

    sa = crit.get("sim_assertion")
    if sa is not None:
        assert sa.get("net") and "min_v" in sa and "max_v" in sa
        assert sa["min_v"] <= sa["max_v"]

    # The prompt must not leak exact resistor values the agent should derive.
    # (Guards issue #106's "don't leak the answer" rule.)
    leak = re.search(r"\b\d+(\.\d+)?\s*k?\s*(ohm|Ω)\b", spec["prompt"], re.IGNORECASE)
    assert leak is None, (
        f"{spec['id']}: prompt appears to leak a resistor value ({leak.group(0)!r}); "
        f"describe the goal, not the component value."
    )


# ---------------------------------------------------------------------------
# The scorer: objective criteria evaluation on a parsed AIR model.
#
# The Design / Unifier view, the predicate solver (evaluate_connectivity), and
# the criteria checks (check_required_components / check_firmware_intent) live in
# ``air.build_score`` (issue #107) and are imported above, so the golden proof
# below and the #107 build harness run the IDENTICAL objective scorer. The block
# that once defined them inline here was lifted VERBATIM into that shared module.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# ngspice must actually be present.
# ---------------------------------------------------------------------------

def test_ngspice_is_available() -> None:
    assert ngspice_path(), (
        "ngspice is not resolvable (AIR_NGSPICE env or PATH). Build-spec golden "
        "validation requires REAL ngspice; a missing simulator must fail the "
        "suite, never pass silently."
    )


@pytest.fixture(scope="module")
def require_ngspice() -> str:
    path = ngspice_path()
    if not path:
        pytest.fail("ngspice not available; build-spec golden validation cannot run.")
    return path


# ---------------------------------------------------------------------------
# The proof: every golden PASSES its own spec's criteria.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("spec", GOLDEN_SPECS, ids=GOLDEN_IDS)
def test_golden_passes_own_criteria(spec: dict, require_ngspice: str, tmp_path: Path) -> None:
    golden = BUILD_SPECS_ROOT / spec["golden"]
    assert golden.exists(), f"{spec['id']}: golden {golden} missing"

    ir, tree = parse_file(golden)
    design = Design(ir)
    crit = spec["criteria"]
    part = resolve_mcu_part(ir)

    # 1. erc_clean
    diagnostics = validate_tree(tree) + validate_ir(ir)
    assert not has_errors(diagnostics), (
        f"{spec['id']}: golden is not ERC-clean: "
        f"{[d.code for d in diagnostics if d.severity == 'error']}"
    )

    # 2. required_components
    ok, msg = check_required_components(design, crit["required_components"])
    assert ok, f"{spec['id']}: required_components failed: {msg}"

    # 3. connectivity (with placeholder unification shared into 4 + 5)
    u = Unifier()
    ok, msg = evaluate_connectivity(design, crit["connectivity"], part, u)
    assert ok, f"{spec['id']}: connectivity failed: {msg}"

    # 4. firmware_intent (declarative ops bound to the resolved nets)
    ok, msg = check_firmware_intent(design, crit["firmware_intent"], u)
    assert ok, f"{spec['id']}: firmware_intent failed: {msg}"

    # 5. sim_assertion (real ngspice; a fallback backend does not count)
    sa = crit.get("sim_assertion")
    if sa is not None:
        out_dir = tmp_path / spec["id"]
        result = simulate_analog(ir, "analog_only", out_dir)
        report = result["reports"][0]
        backend = report["backend"]
        assert backend == "ngspice", (
            f"{spec['id']}: sim_assertion needs real ngspice, got backend {backend!r} "
            f"(a fallback result is not physics evidence, see issue #55)."
        )
        raw = report["measurements"].get(sa["net"])
        assert raw is not None, (
            f"{spec['id']}: net {sa['net']!r} not measured; measured={list(report['measurements'])}"
        )
        value = parse_quantity(raw, "V")
        assert sa["min_v"] <= value <= sa["max_v"], (
            f"{spec['id']}: {sa['net']} = {value:.6g} V outside sim_assertion window "
            f"[{sa['min_v']}, {sa['max_v']}] V."
        )


# ---------------------------------------------------------------------------
# The #107 harness entry point: score_build must score every golden as `built`.
#
# The build harness (packages/agent/bench/build) calls air.build_score.score_build
# on the design the AGENT produces. Validating the harness's exact entry point
# against the goldens here means a live `built: false` can be trusted as a real
# agent failure, not a scorer-wrapper bug (issue #107 guardrail).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("spec", GOLDEN_SPECS, ids=GOLDEN_IDS)
def test_golden_scores_built_via_harness_entrypoint(
    spec: dict, require_ngspice: str, tmp_path: Path
) -> None:
    golden = BUILD_SPECS_ROOT / spec["golden"]
    xml = golden.read_text(encoding="utf-8")
    score = score_build(xml, spec["criteria"], out_dir=tmp_path / spec["id"])
    assert score.built, (
        f"{spec['id']}: harness score_build did NOT score the golden as built "
        f"(failed_criterion={score.failed_criterion!r}, detail={score.detail!r}). "
        f"A golden must score built or the scorer wrapper is wrong."
    )
