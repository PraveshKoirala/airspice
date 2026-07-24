"""Objective build-benchmark scorer (issue #107, child C of epic #104).

This is the SHARED, machine-checkable criteria evaluator for the generative build
benchmark: given a design (an AIR ``SystemIR`` or its XML) and a spec's
``criteria``, it answers a single objective question — *is this design a BUILD?* —
by checking every criterion the corpus (#106) declares:

* required_components   — component types + counts (+ optional part)
* connectivity          — the structural predicate vocabulary in the corpus README
* firmware_intent       — declarative firmware ops bound to the right pins/nets
* erc_clean             — no validation errors
* sim_assertion         — the named net simulates into [min_v, max_v] on REAL ngspice

There is NO LLM judge anywhere in this module. Every predicate is a pure
structural check on the parsed net/pin graph, ERC comes from ``air.validation``,
and the sim assertion is real physics on real ngspice (a ``builtin_dc_fallback``
result does not count — see issue #55). A build passes ONLY if it satisfies ALL
its criteria.

PROVENANCE — this module is the reference criteria evaluator #106 wrote and
verified in ``tests/test_build_specs.py`` (every golden PASSES its own criteria),
lifted VERBATIM into ``air`` so BOTH that golden test AND the #107 build harness
call the SAME code. The only additions over the #106 test body are (a) the
top-level ``score_build`` orchestrator that runs the five checks in order and
returns a structured result, and (b) a GENERIC MCU-part resolver
(``resolve_mcu_part``) so a design the agent built with any MCU component id is
scored the same way (the #106 test hardcoded the golden id ``U_MCU``; the agent
picks its own ids). Neither change weakens a criterion — they make the same
objective checks work on an arbitrary agent-built design.

The connectivity placeholder tokens like ``<sense>`` are UNIFIED: a placeholder
that appears in several predicates (or in ``sim_assertion``) must resolve to the
same net across all of them, which is how "the divider tap is the ADC net" is
checked objectively.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from air.parser import parse_string
from air.registry import MCUS
from air.simulator import simulate_analog
from air.units import parse_quantity
from air.validation import has_errors, validate_ir, validate_tree

ADC_FUNC_RE = re.compile(r"^ADC", re.IGNORECASE)
GPIO_FUNC_TOKENS = {"GPIO", "GPIO_OUT", "PWM"}


# ---------------------------------------------------------------------------
# The scorer: objective criteria evaluation on a parsed AIR model.
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


def resolve_mcu_part(ir) -> str | None:
    """The MCU ``part`` of the design's single MCU component, generically.

    The #106 golden test read ``ir.components["U_MCU"].part`` because every golden
    uses that id. An agent-built design chooses its own component ids, so resolve
    the part from the (single) MCU component's ``type == 'mcu'`` regardless of id.
    Returns None if there is no MCU (a spec that needs one will then fail
    required_components / connectivity, which is correct).
    """
    mcus = [c for c in ir.components.values() if c.type == "mcu"]
    if not mcus:
        return None
    return mcus[0].part


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


def _resolve_gpio_binding_net(design: Design, binding) -> str | None:
    """Resolve a firmware ``binding`` referenced by a ``write_gpio`` op to the net
    of the GPIO pin it names — REAL resolution against the component's DECLARED
    pins, not a blind trust of the binding's ``<net>`` attribute.

    A ``<write_gpio binding="ind_led"/>`` op is the equally-legal alternative to
    ``<write_gpio pin="GPIO8"/>``: instead of naming a pin directly, it references
    a ``<binding>`` that ties a signal to a pin on ``binding.component``. This
    mirrors the SAME resolution the rest of the codebase performs — the documented
    AIR contract (see ``prompts``) is that a binding's ``<channel>`` matches the
    referenced MCU pin's declared ``function``, and both ``firmware._binding_pin_number``
    and ``validation._validate_adc_binding`` resolve a binding by walking the
    referenced component's pins.

    Resolution is UNAMBIGUOUS (never first-match):

    1. Look up ``binding.component``; if it does not exist -> ``None``.
    2. Among that component's DECLARED pins, collect the candidates: pins that are
       GPIO-capable (``function`` in ``GPIO_FUNC_TOKENS``) AND whose ``channel``
       matches the binding's ``channel`` — ``channel == pin.function`` OR
       ``channel == pin.name`` — compared CASE-INSENSITIVELY.
    3. Exactly one candidate -> return that candidate's ``net``.
    4. More than one candidate (e.g. a component declaring two pins that share a
       GPIO function token, bound with a generic channel) -> disambiguate using the
       binding's own declared ``<net>``: if exactly one candidate has
       ``net == binding.net`` return that candidate's ``net``; otherwise ``None``.
    5. Zero candidates -> ``None``.

    The op's target net is always a REAL channel-matched GPIO pin's ``net``, never
    the binding's self-declared ``<net>`` taken on faith: ``<net>`` is used ONLY as
    a disambiguator among legitimately channel-matched pins. A binding naming the
    wrong pin resolves to the wrong net (rejected by the caller's net comparison),
    an ambiguous binding whose ``<net>`` fails to single out one candidate is
    rejected outright, and a binding with no matching declared GPIO pin resolves to
    ``None`` — so the widening never degenerates into "accept any op that has a
    binding attribute".
    """
    if binding is None or not binding.channel:
        return None
    component = design.ir.components.get(binding.component)
    if component is None:
        return None
    channel = binding.channel.strip().lower()
    candidates = [
        pin
        for pin in component.pins.values()
        if pin.function in GPIO_FUNC_TOKENS
        and ((pin.function or "").lower() == channel or (pin.name or "").lower() == channel)
    ]
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0].net
    # Ambiguous channel: disambiguate ONLY by the binding's declared <net>, and
    # only when it uniquely identifies one channel-matched candidate. A <net> that
    # matches zero or multiple candidates leaves the binding ambiguous -> reject
    # (NEVER fall back to first-match, NEVER trust <net> as blind acceptance).
    net_matched = [pin for pin in candidates if pin.net == binding.net]
    if len(net_matched) == 1:
        return net_matched[0].net
    return None


def check_firmware_intent(design: Design, intents: list[str], u: Unifier) -> tuple[bool, str]:
    """Assert the declarative firmware ops exist, bound to the resolved nets.

    read_adc(net=<T>)  -> a firmware binding whose net == resolved(<T>).
    write_gpio(net=<N>) / pwm(net=<N>) / read_gpio(net=<N>)
                       -> a firmware op / binding touching resolved(<N>) (a GPIO
                          pin on that net exists; the declarative op references it).
                          The GPIO op may name its pin EITHER directly
                          (``pin="GPIO8"``) OR via a ``binding="..."`` that resolves
                          to a real GPIO pin on the referenced component (both are
                          legal AIR for the same intent).
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
    # Nets a write_gpio op reaches via a binding= (resolved against the referenced
    # component's DECLARED pins — see _resolve_gpio_binding_net). A write_gpio op
    # may express its target as EITHER pin="GPIO8" OR binding="ind_led"; both are
    # legal AIR for the same intent, so both count.
    gpio_op_binding_nets: set[str] = set()
    has_log = False
    for task in ir.firmware_tasks.values():
        for op in task.operations:
            if op.get("op") == "write_gpio":
                # A write_gpio op may carry pin=, binding=, or BOTH. Each present
                # form contributes its resolved net; the op's reachable nets are the
                # UNION (pin-name nets via the MCU below + binding-resolved nets
                # here), so a design that names the pin both ways is not penalized.
                if op.get("pin"):
                    gpio_op_pins.add(op["pin"])
                binding_id = op.get("binding")
                if binding_id:
                    net = _resolve_gpio_binding_net(design, ir.firmware_bindings.get(binding_id))
                    if net is not None:
                        gpio_op_binding_nets.add(net)
            if op.get("op") == "log":
                has_log = True
    # map GPIO pin names used in ops -> nets via the MCU, plus the binding-resolved
    # nets collected above.
    gpio_op_nets: set[str] = set(gpio_op_binding_nets)
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
# The top-level orchestrator: score a built design against a spec's criteria.
# ---------------------------------------------------------------------------

class BuildScore:
    """The result of scoring one built design against one spec's criteria.

    ``built`` is True iff the design passed EVERY criterion. ``failed_criterion``
    names the first criterion that failed (for the results table); ``detail`` is a
    human-readable reason. ``criteria`` records each criterion's pass/fail for the
    per-spec report row.
    """

    def __init__(self) -> None:
        self.built: bool = False
        self.failed_criterion: str | None = None
        self.detail: str = ""
        self.criteria: dict[str, bool] = {}
        self.sim_backend: str | None = None
        self.sim_value: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "built": self.built,
            "failed_criterion": self.failed_criterion,
            "detail": self.detail,
            "criteria": self.criteria,
            "sim_backend": self.sim_backend,
            "sim_value": self.sim_value,
        }


def score_build(design_xml: str, criteria: dict, out_dir: Path | None = None) -> BuildScore:
    """Score a built design against a spec's ``criteria`` — the objective verdict.

    Runs the FIVE checks in the same order the #106 golden test does. The design
    is a build (``built = True``) only if ALL of them pass; the first failure is
    recorded and evaluation short-circuits (a design that fails ERC has no
    meaningful sim, mirroring the loop: validation gates simulation).

    * erc_clean            — no error-severity diagnostics.
    * required_components  — types + counts (+ optional part).
    * connectivity         — the structural predicate vocabulary (unified).
    * firmware_intent      — declarative ops bound to the resolved nets.
    * sim_assertion        — the named net in [min_v, max_v] on REAL ngspice.

    ``out_dir`` is where the simulator writes its netlist/artifacts; a temp dir if
    omitted. The design XML is parsed here — a parse failure is a build failure
    (an unparseable design is not a build).
    """
    score = BuildScore()

    # Parse. A design that does not parse is not a build.
    try:
        ir, tree = parse_string(design_xml)
    except Exception as exc:  # noqa: BLE001 — any parse failure is a non-build
        score.failed_criterion = "parse"
        score.detail = f"design did not parse: {exc}"
        return score

    design = Design(ir)
    part = resolve_mcu_part(ir)

    # 1. erc_clean
    if criteria.get("erc_clean"):
        diagnostics = validate_tree(tree) + validate_ir(ir)
        erc_ok = not has_errors(diagnostics)
        score.criteria["erc_clean"] = erc_ok
        if not erc_ok:
            codes = [d.code for d in diagnostics if d.severity == "error"]
            score.failed_criterion = "erc_clean"
            score.detail = f"not ERC-clean: {codes}"
            return score

    # 2. required_components
    ok, msg = check_required_components(design, criteria.get("required_components", []))
    score.criteria["required_components"] = ok
    if not ok:
        score.failed_criterion = "required_components"
        score.detail = msg
        return score

    # 3. connectivity (with placeholder unification shared into 4 + 5)
    u = Unifier()
    ok, msg = evaluate_connectivity(design, criteria.get("connectivity", []), part, u)
    score.criteria["connectivity"] = ok
    if not ok:
        score.failed_criterion = "connectivity"
        score.detail = msg
        return score

    # 4. firmware_intent (declarative ops bound to the resolved nets)
    ok, msg = check_firmware_intent(design, criteria.get("firmware_intent", []), u)
    score.criteria["firmware_intent"] = ok
    if not ok:
        score.failed_criterion = "firmware_intent"
        score.detail = msg
        return score

    # 5. sim_assertion (real ngspice; a fallback backend does not count)
    sa = criteria.get("sim_assertion")
    if sa is not None:
        import tempfile

        base = out_dir if out_dir is not None else Path(tempfile.mkdtemp(prefix="build_score_"))
        try:
            result = simulate_analog(ir, "analog_only", base)
        except Exception as exc:  # noqa: BLE001 — a sim crash is a non-build
            score.criteria["sim_assertion"] = False
            score.failed_criterion = "sim_assertion"
            score.detail = f"simulation failed: {exc}"
            return score
        report = result["reports"][0]
        backend = report["backend"]
        score.sim_backend = backend
        if backend != "ngspice":
            score.criteria["sim_assertion"] = False
            score.failed_criterion = "sim_assertion"
            score.detail = (
                f"sim_assertion needs real ngspice, got backend {backend!r} "
                f"(a fallback result is not physics evidence, see issue #55)."
            )
            return score
        raw = report["measurements"].get(sa["net"])
        if raw is None:
            score.criteria["sim_assertion"] = False
            score.failed_criterion = "sim_assertion"
            score.detail = (
                f"net {sa['net']!r} not measured; measured={list(report['measurements'])}"
            )
            return score
        value = parse_quantity(raw, "V")
        score.sim_value = value
        in_window = sa["min_v"] <= value <= sa["max_v"]
        score.criteria["sim_assertion"] = in_window
        if not in_window:
            score.failed_criterion = "sim_assertion"
            score.detail = (
                f"{sa['net']} = {value:.6g} V outside sim_assertion window "
                f"[{sa['min_v']}, {sa['max_v']}] V."
            )
            return score

    # Every criterion passed — this is a build.
    score.built = True
    return score
