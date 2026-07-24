"""Firmware-intent `write_gpio binding=` acceptance + discrimination (issue #113).

The build scorer's ``firmware_intent`` check (``air.build_score.check_firmware_intent``)
counts a ``<write_gpio pin="GPIO2"/>`` op as "firmware wires the GPIO to the target
net", but today it IGNORES the equally-legal ``<write_gpio binding="ind_led"/>`` form
that resolves to a pin via the component's firmware binding. Two legal AIR spellings
of the SAME intent; only the ``pin=`` one is scored (see the ``op.get("pin")`` gate at
``build_score.py`` around line 504). This under-scored ``led_esp32c3_single`` in the
PR #111 smoke.

This module is authored TEST-FIRST, against the CURRENT (un-widened) scorer:

* ``test_binding_form_satisfies_firmware_intent`` and
  ``test_binding_form_scores_built_end_to_end`` are the NEW-FORM ACCEPTANCE tests
  (PRD item 1). They MUST FAIL against today's ``op.get("pin")``-only scorer and
  pass once the ``binding=`` form is honoured. The failing assertion today is::

      write_gpio expected a GPIO op on net 'led_drive'; op-nets=set()

* ``test_pin_form_golden_still_satisfies_firmware_intent`` is a REGRESSION guard: the
  existing ``pin=`` golden must keep passing, so the widening does not break the
  original path.

* ``test_wrong_binding_net_is_rejected`` and ``test_wrong_binding_scores_not_built``
  are the NEW WRONG-BINDING MUTATION (PRD item 4 / hard guardrail): a
  ``<write_gpio binding="ind_led"/>`` whose binding resolves to the WRONG real
  GPIO pin/net must STILL be rejected. This is what proves the widening is REAL
  resolution against the component's pins, not "accept any op with a binding
  attribute" — a naive accept-any-binding widening makes these two tests fail.

* ``test_python_ts_port_parity_on_binding_design`` asserts the TS port scores the
  ``binding=`` design identically to the in-process Python scorer (PRD item 2). The
  TS "port" (``packages/agent/bench/build/scorer.ts``) is a THIN subprocess wrapper
  that spawns ``python -m air.build_score_cli`` — it does not re-implement the
  predicate, so parity is proven by exercising that exact CLI (the TS port's
  computation) and comparing its verdict to ``score_build``.

The full 26-golden / discrimination suite is NOT duplicated here — it lives in
``tests/test_build_specs.py`` (``test_golden_passes_own_criteria`` +
``test_golden_scores_built_via_harness_entrypoint``). ``test_golden_discrimination_
is_covered_by_existing_harness`` references it so the preservation intent is explicit.

Run (no ngspice required — the ``led_esp32c3_single`` criteria carry no
``sim_assertion``, so ``score_build`` runs erc/required/connectivity/firmware only)::

    PYTHONPATH=packages/core/src python -m pytest tests/test_firmware_intent_binding.py -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from air.build_score import (
    Design,
    Unifier,
    check_firmware_intent,
    evaluate_connectivity,
    resolve_mcu_part,
    score_build,
)
from air.parser import parse_file


REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_SRC = REPO_ROOT / "packages" / "core" / "src"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "firmware_binding_113"
SPEC_PATH = (
    REPO_ROOT / "packages" / "agent" / "bench" / "build_specs" / "specs" / "led_esp32c3_single.json"
)
PIN_FORM_GOLDEN = (
    REPO_ROOT
    / "packages"
    / "agent"
    / "bench"
    / "build_specs"
    / "golden"
    / "led_esp32c3_single"
    / "design.air.xml"
)

BINDING_OK = FIXTURES / "led_esp32c3_binding_ok.air.xml"
BINDING_WRONG = FIXTURES / "led_esp32c3_binding_wrong.air.xml"

# The REAL spec criteria the scorer runs for this device. Loading them (rather than
# hand-copying) keeps the test faithful to what production scores; the important line
# is ``firmware_intent: ["write_gpio(net=<led_drive>)"]``.
_SPEC = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
CRITERIA = _SPEC["criteria"]
FIRMWARE_INTENT = CRITERIA["firmware_intent"]


def _design_and_bound_unifier(path: Path) -> tuple[Design, Unifier]:
    """Parse a fixture and return its Design plus a Unifier populated by connectivity.

    This mirrors ``tests/test_build_specs.py::test_golden_passes_own_criteria`` exactly:
    ``firmware_intent`` reads placeholder bindings (``<led_drive>``) that the
    connectivity predicate solver resolves. Connectivity MUST hold for every fixture
    here (they are ERC-clean, well-connected designs) — assert it so a fixture
    regression surfaces as a clear failure rather than a confusing firmware miss.
    """
    ir, _tree = parse_file(path)
    design = Design(ir)
    part = resolve_mcu_part(ir)
    u = Unifier()
    ok, msg = evaluate_connectivity(design, CRITERIA["connectivity"], part, u)
    assert ok, f"fixture {path.name}: connectivity must hold to bind <led_drive>: {msg}"
    # Sanity: the intent's placeholder net actually resolved to the LED drive net.
    assert u.bound.get("led_drive") == "led_drive", (
        f"fixture {path.name}: expected <led_drive> to bind to net 'led_drive', "
        f"got {u.snapshot()}"
    )
    return design, u


# --------------------------------------------------------------------------- #
# PRD item 1 — NEW-FORM ACCEPTANCE. These FAIL against the current scorer and
# pass once `binding=` is honoured.
# --------------------------------------------------------------------------- #

def test_binding_form_satisfies_firmware_intent() -> None:
    """A `<write_gpio binding=ind_led/>` whose binding resolves to the correct
    GPIO pin/net must satisfy `firmware_intent(write_gpio(net=<led_drive>))`.

    FAILS TODAY: the current scorer only counts ops with ``op.get("pin")``, so the
    binding op is invisible and ``op-nets`` is empty. Passes after the widening.
    """
    design, u = _design_and_bound_unifier(BINDING_OK)
    ok, detail = check_firmware_intent(design, FIRMWARE_INTENT, u)
    assert ok, (
        "write_gpio expressed via binding= (resolving to the correct GPIO2/led_drive) "
        f"must satisfy firmware_intent, but the scorer rejected it: {detail!r}"
    )


def test_binding_form_scores_built_end_to_end() -> None:
    """The full `score_build` orchestrator must score the binding-form design as
    built (this spec has no sim_assertion, so no ngspice is needed).

    FAILS TODAY on ``failed_criterion == 'firmware_intent'``; passes after the fix.
    """
    xml = BINDING_OK.read_text(encoding="utf-8")
    score = score_build(xml, CRITERIA)
    assert score.built, (
        "score_build must accept the binding-form design as a build, but it failed "
        f"criterion {score.failed_criterion!r}: {score.detail!r}"
    )
    assert score.criteria.get("firmware_intent") is True


# --------------------------------------------------------------------------- #
# REGRESSION — the existing `pin=` golden must keep passing (widening must not
# break the original path). Green today AND after the fix.
# --------------------------------------------------------------------------- #

def test_pin_form_golden_still_satisfies_firmware_intent() -> None:
    """The shipped `led_esp32c3_single` golden expresses the intent as
    ``<write_gpio pin="GPIO2"/>`` — that path must stay accepted after the widening."""
    design, u = _design_and_bound_unifier(PIN_FORM_GOLDEN)
    ok, detail = check_firmware_intent(design, FIRMWARE_INTENT, u)
    assert ok, f"the pin= golden must keep satisfying firmware_intent: {detail!r}"


# --------------------------------------------------------------------------- #
# PRD item 4 / hard guardrail — NEW WRONG-BINDING MUTATION. A binding that
# resolves to the WRONG real GPIO net must STILL be rejected. These FAIL against a
# naive "accept any op with a binding attribute" widening — that is the point.
# --------------------------------------------------------------------------- #

def test_wrong_binding_net_is_rejected() -> None:
    """A `<write_gpio binding=ind_led/>` whose binding resolves — by declared net AND
    by channel->pin-function — to a DIFFERENT real GPIO pin (GPIO4/aux_drive), not the
    required led_drive, MUST be rejected. Proves the widening is REAL resolution, not
    "accept any binding".

    Rejected by the current scorer (binding invisible) AND required to stay rejected
    after a correct widening. A naive accept-any-binding widening would wrongly accept
    it, failing this assertion.
    """
    design, u = _design_and_bound_unifier(BINDING_WRONG)
    ok, _detail = check_firmware_intent(design, FIRMWARE_INTENT, u)
    assert not ok, (
        "a write_gpio binding that resolves to the WRONG GPIO net (aux_drive, not "
        "led_drive) must NOT satisfy firmware_intent — the scorer accepted it, which "
        "means the binding= acceptance widened to 'accept any binding' instead of "
        "checking the resolved net."
    )


def test_wrong_binding_scores_not_built() -> None:
    """End-to-end: the wrong-binding design must fail `score_build`, and fail on the
    ``firmware_intent`` criterion specifically (everything earlier is clean)."""
    xml = BINDING_WRONG.read_text(encoding="utf-8")
    score = score_build(xml, CRITERIA)
    assert not score.built, (
        "the wrong-binding design must NOT score as a build; it resolved to the wrong "
        f"GPIO net. Got built=True with criteria {score.criteria!r}"
    )
    assert score.failed_criterion == "firmware_intent", (
        "the wrong-binding design must fail specifically on firmware_intent "
        f"(it is ERC-clean and connectivity-valid), got {score.failed_criterion!r}: "
        f"{score.detail!r}"
    )


# --------------------------------------------------------------------------- #
# PRD item 2 — PYTHON <-> TS-PORT PARITY. The TS scorer (bench/build/scorer.ts) is
# a thin subprocess wrapper over `python -m air.build_score_cli`; exercising that CLI
# is exercising the TS port's computation. Its verdict on the binding= design must
# equal the in-process Python scorer's verdict.
# --------------------------------------------------------------------------- #

def _run_ts_port_scorer_cli(design_xml: str, criteria: dict) -> dict:
    """Invoke `air.build_score_cli` exactly as bench/build/scorer.ts does.

    scorer.ts spawns ``python -m air.build_score_cli`` with ``PYTHONPATH`` pointed at
    ``packages/core/src`` and writes ``{design_xml, criteria}`` on stdin, reading the
    score JSON on stdout. We reproduce that contract verbatim.
    """
    env = dict(os.environ)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = str(CORE_SRC) + (os.pathsep + existing if existing else "")
    request = json.dumps({"design_xml": design_xml, "criteria": criteria})
    proc = subprocess.run(
        [sys.executable, "-m", "air.build_score_cli"],
        input=request,
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )
    assert proc.stdout.strip(), (
        f"build_score_cli produced no stdout (exit {proc.returncode}). "
        f"stderr: {proc.stderr[:600]}"
    )
    return json.loads(proc.stdout.strip())


def test_python_ts_port_parity_on_binding_design() -> None:
    """The TS port (via build_score_cli) and the in-process Python scorer must score
    the binding= design IDENTICALLY on the criteria that define the verdict."""
    xml = BINDING_OK.read_text(encoding="utf-8")
    in_process = score_build(xml, CRITERIA).to_dict()
    ts_port = _run_ts_port_scorer_cli(xml, CRITERIA)
    assert ts_port["built"] == in_process["built"], (
        f"parity broken on 'built': TS-port={ts_port['built']} vs "
        f"python={in_process['built']}"
    )
    assert ts_port["failed_criterion"] == in_process["failed_criterion"], (
        f"parity broken on 'failed_criterion': TS-port={ts_port['failed_criterion']!r} "
        f"vs python={in_process['failed_criterion']!r}"
    )
    assert ts_port["criteria"].get("firmware_intent") == in_process["criteria"].get(
        "firmware_intent"
    ), "parity broken on the firmware_intent criterion verdict"


# --------------------------------------------------------------------------- #
# PRD items on discrimination preservation — REFERENCE the existing harness, do
# not duplicate the 26-golden suite here.
# --------------------------------------------------------------------------- #

def test_golden_discrimination_is_covered_by_existing_harness() -> None:
    """Every shipped golden is exercised by tests/test_build_specs.py (the existing
    discrimination proof). This is a pointer, not a re-run: the widening must not
    reduce that suite's discrimination, and it stays the source of truth for the full
    26-golden pass. Kept cheap (no parse/sim) so it runs anywhere."""
    harness = REPO_ROOT / "tests" / "test_build_specs.py"
    assert harness.exists(), "the golden discrimination harness tests/test_build_specs.py is missing"
    specs_dir = REPO_ROOT / "packages" / "agent" / "bench" / "build_specs" / "specs"
    golden_specs = [
        p for p in specs_dir.glob("*.json") if json.loads(p.read_text(encoding="utf-8")).get("golden")
    ]
    assert len(golden_specs) >= 26, (
        f"expected the full golden corpus (>=26) to remain covered by the existing "
        f"harness; found {len(golden_specs)} golden specs"
    )
    text = harness.read_text(encoding="utf-8")
    assert "test_golden_passes_own_criteria" in text and "GOLDEN_SPECS" in text, (
        "test_build_specs.py must still parametrize the goldens through the scorer "
        "checks; do not weaken it to make the widening pass"
    )
