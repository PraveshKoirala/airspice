from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Metadata:
    title: str = ""
    description: str = ""
    author: str = ""
    created_at: str = ""


@dataclass(frozen=True)
class Net:
    id: str
    role: str = ""
    nominal_voltage: str | None = None


@dataclass(frozen=True)
class PowerDomain:
    id: str
    net: str
    nominal: str | None = None
    source: str | None = None


@dataclass(frozen=True)
class PinConnection:
    name: str
    net: str
    function: str | None = None


@dataclass(frozen=True)
class Component:
    id: str
    type: str
    part: str | None = None
    spice_model: str | None = None
    spice_subckt: str | None = None
    value: str | None = None
    pins: dict[str, PinConnection] = field(default_factory=dict)
    properties: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Interface:
    id: str
    type: str
    data: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class Probe:
    id: str
    net: str
    quantity: str


@dataclass(frozen=True)
class AnalogSubsystem:
    id: str
    uses: list[str] = field(default_factory=list)
    probes: list[Probe] = field(default_factory=list)


@dataclass(frozen=True)
class FirmwareProject:
    id: str
    target: str
    framework: str
    language: str
    board: str = ""
    source_tree: str = ""


@dataclass(frozen=True)
class FirmwareBinding:
    id: str
    signal: str
    component: str
    peripheral: str
    channel: str
    net: str


@dataclass(frozen=True)
class FirmwareTask:
    id: str
    target: str
    period: str = ""
    operations: list[dict[str, str]] = field(default_factory=list)


@dataclass(frozen=True)
class Bridge:
    id: str
    type: str
    # Values are either flat attribute strings or nested child-tag dicts
    # (e.g. data["analog_source"] == {"net": "v_out"}); see parser.parse_tree.
    data: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class Analysis:
    """AC small-signal sweep description for a test (issue #62).

    ``type`` today is always ``"ac"``; the field exists so future analyses
    (``dc``, ``noise``, ...) can slot in without another Test attribute. When
    ``type == "ac"`` the four numeric fields (``sweep``, ``points``, ``start``,
    ``end``) are the ngspice ``.ac`` card's arguments verbatim -- ``sweep`` is one
    of ``dec`` / ``oct`` / ``lin`` (§15.3.1 ngspice-46 manual), ``points`` is
    points-per-decade / octave (or total, for ``lin``), and ``start`` / ``end``
    are frequency strings the units module parses to Hz. The emitter renders them
    into ``.ac {sweep} {points} {start_hz} {end_hz}`` (see spice.py).

    When absent from a Test, the compiler falls back to the existing ``.tran``
    emission: adding this dataclass is BACKWARD COMPATIBLE (every corpus/ground-
    truth design without an ``<analysis>`` child is unchanged).
    """

    type: str = "ac"
    sweep: str = "dec"
    points: str = "20"
    start: str = "10Hz"
    end: str = "1MegHz"


@dataclass(frozen=True)
class Test:
    id: str
    description: str = ""
    setup: dict[str, str] = field(default_factory=dict)
    duration: str = ""
    assertions: list[dict[str, str]] = field(default_factory=list)
    analysis: Analysis | None = None


@dataclass(frozen=True)
class SimulationProfile:
    id: str
    default: bool = False
    backends: list[str] = field(default_factory=list)
    included_subsystems: list[str] = field(default_factory=list)
    tests: list[str] = field(default_factory=list)
    properties: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ExportTarget:
    target: str
    enabled: bool


@dataclass(frozen=True)
class SystemIR:
    name: str
    ir_version: str
    metadata: Metadata = field(default_factory=Metadata)
    requirements: list[dict[str, str]] = field(default_factory=list)
    nets: dict[str, Net] = field(default_factory=dict)
    power_domains: dict[str, PowerDomain] = field(default_factory=dict)
    components: dict[str, Component] = field(default_factory=dict)
    interfaces: dict[str, Interface] = field(default_factory=dict)
    analog: list[AnalogSubsystem] = field(default_factory=list)
    firmware_projects: dict[str, FirmwareProject] = field(default_factory=dict)
    firmware_bindings: dict[str, FirmwareBinding] = field(default_factory=dict)
    firmware_tasks: dict[str, FirmwareTask] = field(default_factory=dict)
    bridges: list[Bridge] = field(default_factory=list)
    tests: dict[str, Test] = field(default_factory=dict)
    simulation_profiles: dict[str, SimulationProfile] = field(default_factory=dict)
    exports: list[ExportTarget] = field(default_factory=list)

