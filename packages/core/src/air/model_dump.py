"""Deterministic typed-model serialization for the golden corpus.

``dump-model`` freezes the parsed :class:`~air.model.SystemIR` into JSON that the
TypeScript parser port (issue #7) is diffed against byte-for-byte. Determinism is
therefore the whole point of this module:

* dict keys are sorted (``json.dumps(..., sort_keys=True)``),
* every mapping in ``SystemIR`` (nets, components, pins, ...) is emitted in sorted
  key order regardless of document order,
* every list is emitted in a defined order (by id / name where one exists),
* floats are rendered via ``repr`` so the exact IEEE-754 value round-trips — but
  the typed model here is string-bearing (values like ``"330k"`` stay strings), so
  ``repr`` only matters for the rare genuine float, keeping output stable.

The output is a plain JSON object; the caller decides indentation. The corpus
exporter writes it with ``indent=2`` and a trailing newline.
"""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from typing import Any

from .model import SystemIR


def _plain(value: Any) -> Any:
    """Recursively convert a value into JSON-native, deterministically ordered data.

    * dataclasses -> dict of their fields (recursively)
    * dicts       -> dict with keys sorted at serialization time (sort_keys)
    * lists/tuples -> list (order preserved; callers pre-sort where a stable key exists)
    * floats      -> repr() string is NOT used here; json handles floats, and repr()
                     equality is preserved by Python's float repr since 3.1. We keep
                     the native float so numeric consumers can read it; determinism of
                     text comes from Python's round-trip-safe float repr.
    """
    if is_dataclass(value) and not isinstance(value, type):
        return {f.name: _plain(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    return value


def _sorted_map(mapping: dict[str, Any]) -> dict[str, Any]:
    return {k: _plain(mapping[k]) for k in sorted(mapping)}


def _sorted_list(items: list[Any], key: str) -> list[Any]:
    return [_plain(item) for item in sorted(items, key=lambda i: getattr(i, key, ""))]


def model_to_dict(ir: SystemIR) -> dict[str, Any]:
    """Serialize a :class:`SystemIR` to a deterministically ordered dict.

    Mappings are emitted in sorted-key order and lists in a defined order so the
    output is byte-identical across runs, platforms, and Python dict-insertion order.
    Pins and probes nested inside components/subsystems are likewise sorted.
    """
    components: dict[str, Any] = {}
    for cid in sorted(ir.components):
        comp = ir.components[cid]
        comp_dict = _plain(comp)
        # Pins is a dict keyed by pin name; enforce sorted key order explicitly.
        comp_dict["pins"] = _sorted_map(comp.pins)
        comp_dict["properties"] = _sorted_map(comp.properties)
        components[cid] = comp_dict

    analog: list[Any] = []
    for sub in sorted(ir.analog, key=lambda s: s.id):
        sub_dict = _plain(sub)
        sub_dict["uses"] = sorted(sub.uses)
        sub_dict["probes"] = _sorted_list(sub.probes, "id")
        analog.append(sub_dict)

    tests_dict = _sorted_map(ir.tests)
    # A Test whose ``analysis`` field is None (the historical default -- all
    # corpus designs) must dump WITHOUT the ``analysis`` key at all, not as
    # ``"analysis": null``. This preserves byte-parity with the pre-#62 corpus
    # (which was frozen before Test grew an analysis field) so no fixture needs
    # regenerating. A Test that DOES carry an AC analysis serializes the nested
    # dict via the dataclass fallback in ``_plain``.
    for test_dict in tests_dict.values():
        if isinstance(test_dict, dict) and test_dict.get("analysis") is None:
            test_dict.pop("analysis", None)

    return {
        "name": ir.name,
        "ir_version": ir.ir_version,
        "metadata": _plain(ir.metadata),
        "requirements": [_plain(r) for r in ir.requirements],
        "nets": _sorted_map(ir.nets),
        "power_domains": _sorted_map(ir.power_domains),
        "components": components,
        "interfaces": _sorted_map(ir.interfaces),
        "analog": analog,
        "firmware_projects": _sorted_map(ir.firmware_projects),
        "firmware_bindings": _sorted_map(ir.firmware_bindings),
        "firmware_tasks": _sorted_map(ir.firmware_tasks),
        "bridges": _sorted_list(ir.bridges, "id"),
        "tests": tests_dict,
        "simulation_profiles": _sorted_map(ir.simulation_profiles),
        "exports": _sorted_list(ir.exports, "target"),
    }
