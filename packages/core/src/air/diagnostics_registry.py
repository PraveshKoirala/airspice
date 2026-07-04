"""Loader for the diagnostics registry (registry/diagnostics.json).

The registry is the single source of truth for diagnostic codes the platform
emits: their namespace/owner, severity, message template, parameter names and
remediation hint. See docs/diagnostics_spec.md.

This module is the engine-side consumer of that data. It is intended for NEW
diagnostics going forward: a subsystem minting a new code registers it in
registry/diagnostics.json and then formats its message via ``render_message``
(or reads its severity via ``severity_for``) instead of hardcoding the string,
so the registry and the emitted diagnostic can never drift.

Grandfathered codes (everything already emitted by the Python oracle when the
registry was introduced) keep their existing hardcoded ``builder.make(...)``
call sites verbatim -- migrating them wholesale would churn the golden corpus
for zero user value (issue #44 guardrail). They still appear in the registry
(as ``grandfathered: true``) so the CI checker can prove every emitted code is
registered; they may migrate to this loader opportunistically when next touched.

Pending codes (registry ``pending.entries`` -- codes in flight in another PR)
are NOT loaded into the active registry here: they are not emitted on this
branch yet. They exist in the JSON purely so the code<->registry CI check does
not break whichever of the racing PRs lands second.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


class DiagnosticRegistryError(KeyError):
    """Raised when a code is used that has no active registry entry."""


def _find_registry_path() -> Path:
    """Locate registry/diagnostics.json by walking up from this file.

    The core package lives at packages/core/src/air/; the registry lives at the
    repo root under registry/. Walk parents until we find it so the loader works
    both from an editable install and from a plain PYTHONPATH checkout.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "registry" / "diagnostics.json"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "registry/diagnostics.json not found walking up from "
        f"{here}; the diagnostics registry must ship with the repo."
    )


@lru_cache(maxsize=1)
def load_registry() -> dict[str, dict[str, Any]]:
    """Return the ACTIVE registry as ``{code: entry}``.

    "Active" = the ``diagnostics`` array (codes emitted on this branch). The
    ``pending`` section is deliberately excluded; those codes are not emitted
    here yet. Cached: the registry is immutable data read once per process.
    """
    path = _find_registry_path()
    data = json.loads(path.read_text(encoding="utf-8"))
    entries: dict[str, dict[str, Any]] = {}
    for entry in data.get("diagnostics", []):
        entries[entry["code"]] = entry
    return entries


def get_entry(code: str) -> dict[str, Any]:
    """Return the registry entry for ``code`` or raise DiagnosticRegistryError."""
    try:
        return load_registry()[code]
    except KeyError as exc:
        raise DiagnosticRegistryError(
            f"Diagnostic code {code!r} has no entry in registry/diagnostics.json. "
            "Every new code must be registered before it can be emitted "
            "(see docs/diagnostics_spec.md)."
        ) from exc


def severity_for(code: str) -> str:
    """Return the registered severity ('info' | 'warning' | 'error') for ``code``."""
    return get_entry(code)["severity"]


def render_message(code: str, **params: Any) -> str:
    """Render a registered code's message template with the given parameters.

    Uses the entry's ``message_template`` (Python ``str.format`` placeholders).
    Missing parameters raise ``KeyError`` from ``str.format`` -- surfacing a
    template/emit-site mismatch loudly rather than shipping a half-filled
    message. Intended for NEW codes; grandfathered call sites keep their
    existing f-strings.
    """
    template = get_entry(code)["message_template"]
    return template.format(**params)


def namespace_for(code: str) -> str:
    """Return the registered namespace/owning subsystem tag for ``code``."""
    return get_entry(code)["namespace"]
