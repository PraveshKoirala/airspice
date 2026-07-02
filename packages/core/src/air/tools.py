"""External-tool discovery.

The simulators (ngspice, renode) and the firmware builder (platformio) are often
installed outside the system PATH — portable builds, per-user Python scripts,
vendored toolchains. Relying on ``shutil.which`` alone then silently degrades the
engine to its fallbacks. These helpers check an explicit env-var override first
(e.g. ``AIR_NGSPICE=/path/to/ngspice.exe``, which can live in ``.env``), then the
PATH, so an operator can point the engine at any install.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def find_tool(*candidates: str, env: tuple[str, ...] = ()) -> str | None:
    """Resolve a tool to an absolute path, or ``None`` if not found.

    Order: explicit env-var override(s) -> each candidate name on PATH.
    """
    for var in env:
        override = os.environ.get(var)
        if override and Path(override).exists():
            return override
    for name in candidates:
        found = shutil.which(name)
        if found:
            return found
    return None


def ngspice_path() -> str | None:
    return find_tool("ngspice", "ngspice_con", env=("AIR_NGSPICE",))


def platformio_path() -> str | None:
    return find_tool("platformio", "pio", env=("AIR_PLATFORMIO", "AIR_PIO"))


def renode_path() -> str | None:
    return find_tool("renode", env=("AIR_RENODE",))
