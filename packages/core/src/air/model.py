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
class GuiHint:
    """Optional schematic-position hint for a component (issue #22).

    The design XML may attach a ``<gui x="120" y="240" rot="0"/>`` child to
    any ``<component>``. When present, the UI renders the component at those
    exact coordinates on the schematic canvas instead of running auto-layout
    for it; ``rot`` is a rotation in degrees (0/90/180/270). Absent -> the
    component participates in the ELK/motif fallback path.

    The values are unitless doubles/integers in the schematic's own
    coordinate system; they are grid-snapped by the renderer. This dataclass
    is BACKWARD COMPATIBLE: no pre-#22 corpus design carries a ``<gui>``
    child, so ``Component.gui`` is ``None`` on every existing design and the
    frozen model.json bytes are unchanged (see ``model_dump.model_to_dict``
    for the omit-when-None serialization).
    """

    x: float
    y: float
    rot: int = 0


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
    # Optional schematic-position hint (issue #22). None for every pre-#22
    # design; omitted from model.json when None (see model_dump).
    gui: GuiHint | None = None


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
class FirmwareSource:
    """Inline firmware source carried in a ``<firmware>`` block (issue #36).

    The design XML attaches ``mcu``/``language``/``entry``/``pins`` attributes to
    the ``<firmware>`` element and puts the REAL program text inside a
    ``<source><![CDATA[ ... ]]></source>`` child. This dataclass is the typed
    view of that block::

        <firmware mcu="U_MCU" language="micropython" entry="main" pins="4,5">
          <source><![CDATA[
        from machine import ADC, Pin
        ...
          ]]></source>
        </firmware>

    * ``mcu`` -- id of a component whose registry type is an MCU (validated).
    * ``language`` -- runtime language tag (``micropython`` today; this is what
      #37's mpy-wasm runtime executes).
    * ``entry`` -- entry-point symbol the runtime invokes.
    * ``pins`` -- an explicit DECLARED-PINS manifest: the comma-separated pin ids
      the firmware uses, parsed to a tuple in document order. Validation checks
      each against the MCU registry; the source is NEVER statically analyzed to
      discover pins (the sanctioned simpler design per the issue).
    * ``source`` -- the raw program text, preserved BYTE-EXACT (no reindent, no
      newline normalization beyond the XML parser's line-ending rule, no
      trimming). The canonicalizer re-emits it in CDATA, split-escaping any
      literal ``]]>`` so it round-trips exactly.

    This addition is BACKWARD COMPATIBLE: ``SystemIR.firmware_source`` is ``None``
    for every design without a ``<source>`` child, and ``model_dump`` omits the
    key entirely when ``None`` so the frozen corpus bytes are unchanged.
    """

    mcu: str
    language: str
    entry: str
    pins: tuple[str, ...] = ()
    source: str = ""


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
    # Optional inline firmware source block (issue #36). None for every design
    # without a <firmware><source> child; omitted from model.json when None.
    firmware_source: FirmwareSource | None = None
    bridges: list[Bridge] = field(default_factory=list)
    tests: dict[str, Test] = field(default_factory=dict)
    simulation_profiles: dict[str, SimulationProfile] = field(default_factory=dict)
    exports: list[ExportTarget] = field(default_factory=list)

