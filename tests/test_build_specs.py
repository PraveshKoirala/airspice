"""Build-benchmark spec corpus validation (issue #106).

Loads every spec under ``packages/agent/bench/build_specs/specs/*.json`` and, for
each spec that ships a ``golden`` reference, runs the golden design through the
SAME objective, machine-checkable criteria the child-C scorer (#107) will run:

* required_components   — component types + counts (+ optional part)
* connectivity          — the structural predicate vocabulary in the corpus README
* firmware_intent       — declarative firmware ops bound to the right pins/nets
* erc_clean             — no validation errors
* sim_assertion         — the named net simulates into [min_v, max_v] on ngspice

A golden that fails its OWN spec's criteria fails the suite loudly — that is the
whole point: it proves the criteria are satisfiable and not mis-specified (a spec
whose golden cannot pass its own criteria is a broken spec, per issue #106 and
AGENTS.md's prime directive). This module is ALSO the reference implementation of
the scorer's criteria evaluation; #107 consumes the vocabulary it encodes.

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

from air.parser import parse_file
from air.registry import MCUS
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
ADC_FUNC_RE = re.compile(r"^ADC", re.IGNORECASE)
GPIO_FUNC_TOKENS = {"GPIO", "GPIO_OUT", "PWM"}


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
# The scorer: objective criteria evaluation on a parsed AIR model
# ---------------------------------------------------------------------------

class Design:
    """A thin structural view over a parsed AIR ``SystemIR`` for scoring."""

    def __init__(self, ir) -> None:
        self.ir = ir
        self.ground_nets = {n.id for n in ir.nets.values() if n.role == "ground"}
        self.power_nets = {n.id for n in ir.nets.values() if n.role == "power"}

    # -- component helpers --
    def by_type(self, ty: str) -> list:
        return [c for c in self.ir.components.values() if c.type == ty]

    def net_role(self, net_id: str) -> str | None:
        n = self.ir.nets.get(net_id)
        return n.role if n else None

    def component_nets(self, c) -> list[str]:
        return [p.net for p in c.pins.values()]

    def two_terminal(self, ty: str):
        """Yield (component, {netA, netB}) for 2-pin components of a type."""
        for c in self.by_type(ty):
            nets = self.component_nets(c)
            if len(nets) >= 2:
                yield c, nets


class Unifier:
    """Resolves ``<placeholder>`` tokens to concrete nets consistently."""

    def __init__(self) -> None:
        self.bound: dict[str, str] = {}

    @staticmethod
    def is_placeholder(tok: str) -> bool:
        return tok.startswith("<") and tok.endswith(">")

    def name(self, tok: str) -> str:
        return tok[1:-1]

    def try_bind(self, tok: str, net: str) -> bool:
        if not self.is_placeholder(tok):
            return tok == net
        key = self.name(tok)
        if key in self.bound:
            return self.bound[key] == net
        self.bound[key] = net
        return True

    def snapshot(self) -> dict[str, str]:
        return dict(self.bound)

    def restore(self, snap: dict[str, str]) -> None:
        self.bound = dict(snap)


def _mcu_pin_functions(design: Design, part: str, net: str) -> list[str]:
    """All declared pin functions the given MCU part exposes on ``net``."""
    funcs: list[str] = []
    for c in design.by_type("mcu"):
        if c.part != part:
            continue
        for pin in c.pins.values():
            if pin.net == net and pin.function:
                funcs.append(pin.function)
    return funcs


# --------------------------------------------------------------------------- #
# Predicate evaluators.
#
# Each predicate is a GENERATOR yielding every way it can be satisfied given the
# current bindings, as a dict of NEW placeholder->net bindings to add. Yielding
# all candidates (rather than committing to the first) is what makes
# ``evaluate_connectivity`` backtrack correctly: a later predicate that can't be
# satisfied under one choice forces the DFS to try the earlier predicate's next
# candidate. This is a small, deterministic constraint solver -- no LLM judge.
# --------------------------------------------------------------------------- #

def _bind(u: "Unifier", tok: str, net: str, design: "Design", delta: dict) -> bool:
    """Attempt to bind tok to net under u+delta; on success record into delta."""
    if tok == "gnd":
        return net in design.ground_nets
    if tok == "<power>":
        return net in design.power_nets
    if not Unifier.is_placeholder(tok):
        return tok == net
    key = tok[1:-1]
    cur = u.bound.get(key, delta.get(key))
    if cur is not None:
        return cur == net
    delta[key] = net
    return True


def _gen_series_divider(design, u, kw):
    high, tap, low = kw["high"], kw["tap"], kw["low"]
    resistors = list(design.two_terminal("resistor"))
    for c1, n1 in resistors:
        for c2, n2 in resistors:
            if c1 is c2:
                continue
            for tap_net in set(n1) & set(n2):
                hi = set(n1) - {tap_net}
                lo = set(n2) - {tap_net}
                if not hi or not lo:
                    continue
                hi_net, lo_net = next(iter(hi)), next(iter(lo))
                delta: dict = {}
                if (_bind(u, tap, tap_net, design, delta)
                        and _bind(u, high, hi_net, design, delta)
                        and _bind(u, low, lo_net, design, delta)):
                    yield delta


def _gen_adc_input(design, u, kw, part):
    want = kw.get("mcu", part)
    for c in design.by_type("mcu"):
        if c.part != want:
            continue
        for pin in c.pins.values():
            if pin.function and ADC_FUNC_RE.match(pin.function):
                delta: dict = {}
                if _bind(u, kw["net"], pin.net, design, delta):
                    yield delta


def _gen_gpio(design, u, kw, part):
    want = kw.get("mcu", part)
    for c in design.by_type("mcu"):
        if c.part != want:
            continue
        for pin in c.pins.values():
            if pin.function in GPIO_FUNC_TOKENS:
                delta: dict = {}
                if _bind(u, kw["net"], pin.net, design, delta):
                    yield delta


def _gen_pullup(design, u, kw):
    for c, nets in design.two_terminal("resistor"):
        for a, b in ((nets[0], nets[1]), (nets[1], nets[0])):
            if design.net_role(b) != "power":
                continue
            delta: dict = {}
            if _bind(u, kw["net"], a, design, delta) and _bind(u, kw["to"], b, design, delta):
                yield delta


def _gen_series_element(design, u, kw):
    ty, a_tok, b_tok = kw["type"], kw["a"], kw["b"]
    for c, nets in design.two_terminal(ty):
        for a, b in ((nets[0], nets[1]), (nets[1], nets[0])):
            delta: dict = {}
            if _bind(u, a_tok, a, design, delta) and _bind(u, b_tok, b, design, delta):
                yield delta


def _gen_current_limit_resistor(design, u, kw):
    yield from _gen_series_element(design, u, {"type": "resistor", "a": kw["gpio"], "b": kw["load"]})


def _gen_series_diode(design, u, kw):
    for c in design.by_type("diode"):
        a, k = c.pins.get("a"), c.pins.get("c")
        if not a or not k:
            continue
        delta: dict = {}
        if _bind(u, kw["anode"], a.net, design, delta) and _bind(u, kw["cathode"], k.net, design, delta):
            yield delta


def _switch_pins(sw_ty):
    return ("B", "C", "E") if sw_ty == "bjt" else ("G", "D", "S")


def _gen_low_side_switch(design, u, kw):
    ctrl_pin, sw_pin, com_pin = _switch_pins(kw["sw"])
    common = kw.get("common", "gnd")
    for c in design.by_type(kw["sw"]):
        ctrl, sw, com = c.pins.get(ctrl_pin), c.pins.get(sw_pin), c.pins.get(com_pin)
        if not (ctrl and sw and com):
            continue
        delta: dict = {}
        if (_bind(u, kw["control"], ctrl.net, design, delta)
                and _bind(u, kw["load"], sw.net, design, delta)
                and _bind(u, common, com.net, design, delta)):
            yield delta


def _gen_high_side_switch(design, u, kw):
    ctrl_pin, sw_pin, com_pin = _switch_pins(kw["sw"])
    for c in design.by_type(kw["sw"]):
        ctrl, sw, com = c.pins.get(ctrl_pin), c.pins.get(sw_pin), c.pins.get(com_pin)
        if not (ctrl and sw and com) or design.net_role(com.net) != "power":
            continue
        delta: dict = {}
        if (_bind(u, kw["control"], ctrl.net, design, delta)
                and _bind(u, kw["load"], sw.net, design, delta)
                and _bind(u, kw["rail"], com.net, design, delta)):
            yield delta


def _gen_flyback_diode(design, u, kw):
    for c in design.by_type("diode"):
        a, k = c.pins.get("a"), c.pins.get("c")
        if not a or not k or design.net_role(k.net) != "power":
            continue
        delta: dict = {}
        if _bind(u, kw["across"], a.net, design, delta) and _bind(u, kw["rail"], k.net, design, delta):
            yield delta


def _gen_rc_lowpass(design, u, kw):
    for rc, rnets in design.two_terminal("resistor"):
        for a, b in ((rnets[0], rnets[1]), (rnets[1], rnets[0])):
            for cc, cnets in design.two_terminal("capacitor"):
                if b in cnets and (set(cnets) - {b}) & design.ground_nets:
                    delta: dict = {}
                    if _bind(u, kw["in"], a, design, delta) and _bind(u, kw["out"], b, design, delta):
                        yield delta


def _gen_regulator(design, u, kw):
    gnd_tok = kw.get("gnd", "gnd")
    for c in design.by_type("ldo"):
        vin, vout, g = c.pins.get("in"), c.pins.get("out"), c.pins.get("gnd")
        if not (vin and vout and g):
            continue
        delta: dict = {}
        if (_bind(u, kw["in"], vin.net, design, delta)
                and _bind(u, kw["out"], vout.net, design, delta)
                and _bind(u, gnd_tok, g.net, design, delta)):
            yield delta


def _gen_mcu_powered(design, u, kw, part):
    want = kw.get("mcu", part)
    for c in design.by_type("mcu"):
        if c.part != want:
            continue
        reg = MCUS.get(want, {})
        pwr_pins = reg.get("power_pins", {})
        pwr_name = next((n for n, role in pwr_pins.items() if role == "power"), None)
        gnd_name = next((n for n, role in pwr_pins.items() if role == "ground"), None)
        pwr = c.pins.get(pwr_name) if pwr_name else None
        gnd = c.pins.get(gnd_name) if gnd_name else None
        if not pwr or not gnd:
            continue
        if design.net_role(pwr.net) != "power" or gnd.net not in design.ground_nets:
            continue
        delta: dict = {}
        if _bind(u, kw["rail"], pwr.net, design, delta):
            yield delta


def _gen_i2c_bus(design, u, kw):
    for iface in design.ir.interfaces.values():
        if iface.type != "i2c":
            continue
        data = iface.data
        sda = data.get("sda", {}).get("net") if isinstance(data.get("sda"), dict) else None
        scl = data.get("scl", {}).get("net") if isinstance(data.get("scl"), dict) else None
        pullups = data.get("pullup")
        pullups = pullups if isinstance(pullups, list) else ([pullups] if pullups else [])
        power_rails = [p.get("to") for p in pullups if isinstance(p, dict) and design.net_role(p.get("to")) == "power"]
        if not sda or not scl or len(pullups) < 2 or not power_rails:
            continue
        delta: dict = {}
        if (_bind(u, kw["sda"], sda, design, delta)
                and _bind(u, kw["scl"], scl, design, delta)
                and _bind(u, kw["rail"], power_rails[0], design, delta)):
            yield delta


def _gen_load_on_rail(design, u, kw):
    for c in design.by_type("generic_load"):
        for pin in c.pins.values():
            if design.net_role(pin.net) == "power":
                delta: dict = {}
                if _bind(u, kw["rail"], pin.net, design, delta):
                    yield delta


def _gen_decoupling_cap(design, u, kw):
    for c, nets in design.two_terminal("capacitor"):
        gnd_side = set(nets) & design.ground_nets
        other = set(nets) - design.ground_nets
        if gnd_side and other:
            delta: dict = {}
            if _bind(u, kw["net"], next(iter(other)), design, delta):
                yield delta



_PRED_RE = re.compile(r"^(\w+)\((.*)\)$")


def _parse_kv(argstr: str) -> tuple[list[str], dict[str, str]]:
    """Parse ``a=<x>, b=gnd, type=resistor`` into positional + keyword parts."""
    positional: list[str] = []
    kw: dict[str, str] = {}
    for part in argstr.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
            kw[k.strip()] = v.strip()
        else:
            positional.append(part)
    return positional, kw


_GENERATORS = {
    "series_divider": _gen_series_divider,
    "pullup": _gen_pullup,
    "series_element": _gen_series_element,
    "current_limit_resistor": _gen_current_limit_resistor,
    "series_diode": _gen_series_diode,
    "low_side_switch": _gen_low_side_switch,
    "high_side_switch": _gen_high_side_switch,
    "flyback_diode": _gen_flyback_diode,
    "rc_lowpass": _gen_rc_lowpass,
    "regulator": _gen_regulator,
    "i2c_bus": _gen_i2c_bus,
    "load_on_rail": _gen_load_on_rail,
    "decoupling_cap": _gen_decoupling_cap,
}
# generators that additionally need the MCU part for a default 'mcu' argument
_GENERATORS_WITH_PART = {
    "adc_input": _gen_adc_input,
    "gpio_output": _gen_gpio,
    "gpio_input": _gen_gpio,
    "mcu_powered": _gen_mcu_powered,
}


def _candidates(design, u, name, kw, part):
    if name in _GENERATORS:
        yield from _GENERATORS[name](design, u, kw)
    elif name in _GENERATORS_WITH_PART:
        yield from _GENERATORS_WITH_PART[name](design, u, kw, part)
    else:
        raise AssertionError(f"unknown connectivity predicate {name!r}")


def evaluate_connectivity(design: Design, patterns: list[str], part: str, u: Unifier) -> tuple[bool, str]:
    """All predicates must hold under ONE consistent set of placeholder bindings.

    A depth-first search with backtracking: for predicate i we try each candidate
    binding-delta it yields, recurse into predicate i+1, and undo the delta if the
    recursion fails. This is what lets a shared placeholder (e.g. the divider tap
    that must ALSO be the ADC net) reject a wrong early choice. ``u.bound`` holds
    the winning assignment on success (used by firmware_intent).
    """
    parsed = []
    for pat in patterns:
        m = _PRED_RE.match(pat.strip())
        assert m, f"unparseable connectivity predicate: {pat!r}"
        _, kw = _parse_kv(m.group(2))
        parsed.append((pat, m.group(1), kw))

    failure = {"pat": None}

    def dfs(i: int) -> bool:
        if i == len(parsed):
            return True
        pat, name, kw = parsed[i]
        found_any = False
        for delta in _candidates(design, u, name, kw, part):
            found_any = True
            u.bound.update(delta)
            if dfs(i + 1):
                return True
            for k in delta:
                u.bound.pop(k, None)
        if not found_any and failure["pat"] is None:
            failure["pat"] = pat
        return False

    if dfs(0):
        return True, ""
    reason = failure["pat"] or (parsed[-1][0] if parsed else "?")
    return False, f"no consistent binding; first unsatisfiable predicate ~ {reason!r} (partial: {u.snapshot()})"


def check_required_components(design: Design, required: list[dict]) -> tuple[bool, str]:
    counts: dict[str, int] = {}
    part_counts: dict[tuple[str, str], int] = {}
    for c in design.ir.components.values():
        counts[c.type] = counts.get(c.type, 0) + 1
        if c.part:
            part_counts[(c.type, c.part)] = part_counts.get((c.type, c.part), 0) + 1
    for rc in required:
        ty = rc["type"]; need = rc["count"]
        if counts.get(ty, 0) < need:
            return False, f"need >= {need} of type {ty!r}, found {counts.get(ty, 0)}"
        part = rc.get("part")
        if part and part_counts.get((ty, part), 0) < need:
            return False, f"need >= {need} of {ty!r} with part {part!r}, found {part_counts.get((ty, part), 0)}"
    return True, ""


_FW_RE = re.compile(r"^(\w+)\((.*)\)$")


def check_firmware_intent(design: Design, intents: list[str], u: Unifier) -> tuple[bool, str]:
    """Assert the declarative firmware ops exist, bound to the resolved nets.

    read_adc(net=<T>)  -> a firmware binding whose net == resolved(<T>).
    write_gpio(net=<N>) / pwm(net=<N>) / read_gpio(net=<N>)
                       -> a firmware op / binding touching resolved(<N>) (a GPIO
                          pin on that net exists; the declarative op references it).
    'log'              -> some task carries a <log>.
    """
    ir = design.ir

    def resolve(argstr: str) -> str | None:
        _, kw = _parse_kv(argstr)
        net = kw.get("net")
        if net is None:
            return None
        if Unifier.is_placeholder(net):
            return u.bound.get(u.name(net))
        return net

    # collect firmware facts
    adc_binding_nets = {b.net for b in ir.firmware_bindings.values()}
    gpio_op_pins: set[str] = set()
    has_log = False
    for task in ir.firmware_tasks.values():
        for op in task.operations:
            if op.get("op") == "write_gpio" and op.get("pin"):
                gpio_op_pins.add(op["pin"])
            if op.get("op") == "log":
                has_log = True
    # map GPIO pin names used in ops -> nets via the MCU
    gpio_op_nets: set[str] = set()
    for c in design.by_type("mcu"):
        for pin in c.pins.values():
            if pin.name in gpio_op_pins:
                gpio_op_nets.add(pin.net)

    for intent in intents:
        if intent == "log":
            if not has_log:
                return False, "firmware_intent 'log' present but no <log> op found"
            continue
        m = _FW_RE.match(intent.strip())
        assert m, f"unparseable firmware_intent: {intent!r}"
        op_name, argstr = m.group(1), m.group(2)
        net = resolve(argstr)
        if op_name == "read_adc":
            if net is None or net not in adc_binding_nets:
                return False, f"read_adc expected an ADC binding on net {net!r}; bindings={adc_binding_nets}"
        elif op_name in ("write_gpio", "pwm"):
            if net is None or net not in gpio_op_nets:
                return False, f"{op_name} expected a GPIO op on net {net!r}; op-nets={gpio_op_nets}"
        elif op_name == "read_gpio":
            # declarative read of a digital input: a GPIO pin on that net exists.
            pin_nets = {p.net for c in design.by_type("mcu") for p in c.pins.values()
                        if p.function in GPIO_FUNC_TOKENS or (p.function or "").startswith("ADC")}
            if net is None or net not in pin_nets:
                return False, f"read_gpio expected an input pin on net {net!r}; input-nets={pin_nets}"
        else:
            raise AssertionError(f"unknown firmware_intent op {op_name!r}")
    return True, ""


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
    part = ir.components["U_MCU"].part if "U_MCU" in ir.components else None

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
