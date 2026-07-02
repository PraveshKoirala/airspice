from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .diagnostics import Diagnostic


ArtifactKind = Literal[
    "spice_netlist",
    "spice_control",
    "renode_platform",
    "renode_script",
    "renode_test",
    "firmware_source",
    "firmware_config",
    "firmware_header",
    "report",
    "waveform",
    "graph_json",
]


@dataclass(frozen=True)
class Artifact:
    path: str
    kind: ArtifactKind


@dataclass(frozen=True)
class CompileResult:
    target: str
    success: bool
    artifacts: list[Artifact]
    diagnostics: list[Diagnostic]
