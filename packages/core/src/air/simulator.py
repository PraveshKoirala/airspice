from __future__ import annotations

import csv
import json
from pathlib import Path
import subprocess
from dataclasses import dataclass

from .diagnostics import Diagnostic, DiagnosticBuilder
from .model import Component, SystemIR, Test
from .spice import compile_spice
from .units import format_quantity, parse_quantity


@dataclass(frozen=True)
class SignalStats:
    final: float
    min: float
    max: float
    time_of_min: float
    time_of_max: float
    unit: str


@dataclass(frozen=True)
class LadderRung:
    """One rung of the fixed, deterministic convergence-aid ladder (issue #45).

    ``options`` are the extra ``.options`` tokens ADDED to the compiler's netlist
    for this rung (rung 1's are empty: the design exactly as written). ``relaxes``
    marks the rung that trades accuracy for convergence (rung 4), so the report
    can say so — silent accuracy loss is the failure this ladder prevents.
    """

    rung: int
    name: str
    options: tuple[str, ...]
    relaxes: bool = False


# The ladder is FIXED and FINITE: max 4 rungs, no randomized elements, no
# adaptive/per-circuit tuning. Order and every option are justified against the
# ngspice-46 manual in docs/convergence_ladder.md (do NOT change one without the
# other). Rung 1 is ALWAYS the design as written (parity requirement): an
# already-converging design is solved here and its measurements never change.
# Rungs 2->3 walk ngspice's own documented aid order (manual §11.3.5: gmin
# stepping then source stepping), escalated beyond their defaults; rung 4 is the
# only rung that changes the answer's character (Gear method + reltol relaxed one
# notch), so it is last and it is always reported.
CONVERGENCE_LADDER: tuple[LadderRung, ...] = (
    LadderRung(1, "as-written", ()),
    LadderRung(2, "gmin stepping", ("gminsteps=1", "itl1=500")),
    LadderRung(3, "source stepping", ("srcsteps=10", "gminsteps=1", "itl1=500")),
    LadderRung(
        4,
        "Gear + relaxed reltol",
        ("method=gear", "reltol=0.005", "srcsteps=10", "gminsteps=1", "itl1=500", "itl4=100"),
        relaxes=True,
    ),
)


@dataclass(frozen=True)
class NgspiceRun:
    """Outcome of an ngspice invocation.

    ``attempted`` distinguishes the two very different reasons ngspice did not
    credit its numbers to the report:

    - ``attempted is False`` -> no ngspice binary was reachable. This is the
      legitimate ngspice-not-installed case: the engine falls back to the
      deterministic builtin DC solver (see docs/simulation_spec.md). Nothing
      failed; the report is honestly labelled ``builtin_dc_fallback``.
    - ``attempted is True`` with ``returncode != 0`` -> ngspice ran and FAILED
      (e.g. a device line references a ``.model``/``.subckt`` the netlist never
      defines). This is a hard simulation failure and MUST surface as such; it
      must never be silently downgraded to a clean ``passed`` DC report.
    """

    attempted: bool
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""

    @property
    def failed(self) -> bool:
        return self.attempted and self.returncode != 0


def simulate_analog(ir: SystemIR, profile_id: str, out_dir: Path) -> dict[str, object]:
    profile = ir.simulation_profiles.get(profile_id)
    if profile is None:
        raise ValueError(f"Unknown simulation profile: {profile_id}")
    if "ngspice" not in profile.backends:
        raise ValueError(f"Profile {profile_id} does not include ngspice backend")

    # Collect probes from included subsystems
    subsystems = {s.id: s for s in ir.analog}
    extra_probe_nets = set()
    for sub_id in profile.included_subsystems:
        if sub_id in subsystems:
            for probe in subsystems[sub_id].probes:
                extra_probe_nets.add(probe.net)

    # Graceful degradation for the ngspice-MISSING path only: if a profile asks
    # for the ngspice backend but no ngspice binary is resolvable (not on PATH and
    # AIR_NGSPICE unset/invalid), the transient can't run and the numbers below
    # come from the built-in DC solver. Surface that as an actionable info
    # diagnostic on every report instead of silently degrading. This does NOT
    # change measurements, does NOT flip status, and does NOT touch how a *present*
    # ngspice's nonzero exit is handled (that failure path is owned elsewhere).
    from .tools import ngspice_path

    ngspice_missing = ngspice_path() is None
    missing_diag_builder = DiagnosticBuilder()

    reports = []
    status = "passed"
    for test_id in profile.tests:
        test = ir.tests[test_id]
        builder = DiagnosticBuilder()

        # Merge extra probes with assertion-based probes for cleanup and stats
        assertion_nets = {a.get("net", "") for a in test.assertions if a.get("op") == "assert_voltage" and a.get("net")}
        all_probe_nets = sorted(assertion_nets | extra_probe_nets)

        _clear_test_waveforms_explicit(out_dir / "waveforms", test, all_probe_nets)
        compile_result = compile_spice(ir, out_dir, test, extra_probes=list(extra_probe_nets))
        # Convergence-aid ladder (issue #45): run as-written first, always; if that
        # does not converge, escalate the documented ngspice aids in a fixed order.
        # The winning rung's run + waveforms are what the report is built from, and
        # a `convergence` section records every attempt (which rung succeeded, or
        # that the ladder was exhausted). See docs/convergence_ladder.md.
        ladder = run_convergence_ladder(
            out_dir / "spice" / "main.cir",
            out_dir / "reports" / f"{test.id}.ngspice.log",
            out_dir / "waveforms",
            test,
            all_probe_nets,
        )
        ngspice_run = ladder.run
        convergence = _convergence_section(ladder)
        measured = _measure_dc(ir, test)
        stats = _stats_from_measurements(measured)
        waveform_stats = ladder.waveform_stats
        if waveform_stats:
            stats.update(waveform_stats)
            measured.update({name: signal.final for name, signal in waveform_stats.items()})
        # Only credit ngspice when its transient actually produced readable data;
        # a clean exit with no waveforms still means the numbers came from the
        # builtin DC solver, so the backend label must say so.
        used_ngspice = ngspice_run.attempted and ngspice_run.returncode == 0 and bool(waveform_stats)
        # A non-zero ngspice exit is a HARD failure: the transient never ran. It
        # must NOT be silently downgraded to a clean builtin-DC "passed" report
        # (issue #55). The failure is recorded as a structured diagnostic and the
        # backend label reflects that ngspice failed. The builtin DC fallback path
        # stays reserved for ngspice-not-installed (its documented purpose).
        sim_diagnostics: list[Diagnostic] = []
        if ngspice_run.failed:
            sim_diagnostics.append(_ngspice_failure_diagnostic(builder, test.id, ngspice_run))
        # Terminal convergence failure (issue #45): the ladder tried every rung and
        # none converged. Surface a topology-directed remediation (SIM-010) in
        # addition to NGSPICE_FAILED's raw exit/stderr, so the user and the repair
        # agent are pointed at the topology, not at value-twiddling.
        if convergence["terminal"]:
            sim_diagnostics.append(_terminal_convergence_diagnostic(builder, test.id))
        if used_ngspice:
            # ngspice wrote whitespace-delimited wrdata; normalize each probe CSV
            # into the canonical comma+header form the UI/readback consume.
            for net in all_probe_nets:
                wave_path = out_dir / "waveforms" / f"{test.id}_{net}.csv"
                samples = _read_samples(wave_path)
                if samples:
                    _write_canonical_waveform(wave_path, net, samples)
        assertion_diagnostics = _evaluate_assertions(test, measured, stats)
        diagnostics = sim_diagnostics + assertion_diagnostics
        if ngspice_run.failed:
            backend = "ngspice_failed"
        elif used_ngspice:
            backend = "ngspice"
        else:
            backend = "builtin_dc_fallback"
        test_status = "failed" if diagnostics else "passed"
        if test_status == "failed":
            status = "failed"
        report_diagnostics = diagnostics + compile_result.diagnostics
        if ngspice_missing and not used_ngspice:
            report_diagnostics = report_diagnostics + [_ngspice_missing_diagnostic(missing_diag_builder, test.id)]
        waveform_artifacts = [str(out_dir / "waveforms" / f"{test.id}_{net}.csv") for net in all_probe_nets]
        report = {
            "profile": profile_id,
            "test": test.id,
            "status": test_status,
            "backend": backend,
            "convergence": convergence,
            "measurements": {name: format_quantity(value, _unit_for_signal(name)) for name, value in measured.items()},
            "measurement_stats": _serialize_stats(stats),
            "diagnostics": [d.to_dict() for d in report_diagnostics],
            "artifacts": [artifact.path for artifact in compile_result.artifacts] + waveform_artifacts,
        }
        report_path = out_dir / "reports" / f"{test.id}.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        # Only fill the builtin-DC waveform CSVs when we are legitimately on the
        # fallback (ngspice not installed). A hard ngspice failure does NOT get
        # papered over with synthetic flat waveforms.
        if backend == "builtin_dc_fallback":
            _write_waveforms(out_dir / "waveforms", test, measured, nets=all_probe_nets)
        reports.append(report)
    return {"success": status == "passed", "profile": profile_id, "status": status, "reports": reports}


def prepare_renode_feedback(ir: SystemIR, test: Test, out_dir: Path) -> list[str]:
    commands = []
    wave_dir = out_dir / "waveforms"
    for bridge in ir.bridges:
        if bridge.type == "adc":
            # Bridge data might be flat or nested depending on parser fix.
            # Based on the latest parser fix: bridge.data has child tags as keys.
            source = bridge.data.get("analog_source", {})
            source_net = source.get("net")
            if not source_net:
                continue
            path = wave_dir / f"{test.id}_{source_net}.csv"
            if not path.exists():
                continue

            target = bridge.data.get("digital_target", {})
            ch_str = target.get("channel", "0")
            channel = 0
            if "CH" in ch_str:
                try:
                    channel = int(ch_str.split("CH")[-1])
                except ValueError:
                    pass

            conv = bridge.data.get("conversion", {})
            ref = parse_quantity(conv.get("reference_voltage", "3.3V"), "V")
            bits = int(conv.get("bits", "12"))

            with path.open("r", encoding="utf-8") as f:
                reader = csv.reader(f)
                next(reader)
                rows = list(reader)
                # Sample the waveform to avoid too many commands
                sample_count = 50
                step = max(1, len(rows) // sample_count)
                for i in range(0, len(rows), step):
                    row = rows[i]
                    if not row: continue
                    time = float(row[0])
                    value = float(row[1])
                    raw = int((value / ref) * (2**bits - 1))
                    raw = max(0, min(2**bits - 1, raw))
                    commands.append(f"emulation Sleep \"{time:.6f}\"")
                    commands.append(f"sysbus.adc FeedSample {raw} {channel}")
    return commands


_NGSPICE_INSTALL_URL = "https://ngspice.sourceforge.io/download.html"


def _ngspice_missing_diagnostic(builder: DiagnosticBuilder, test_id: str) -> Diagnostic:
    """Actionable diagnostic for the ngspice-not-installed case.

    Emitted (as info, never error) when a profile requests the ngspice backend
    but no ngspice binary is resolvable. The measurements in the report come from
    the built-in DC solver, so the operator needs to know the real transient
    engine never ran and how to install it.
    """
    return builder.make(
        "info",
        "analog",
        "NGSPICE_NOT_FOUND",
        "ngspice not found - analog results came from the built-in DC solver, "
        "not a real transient simulation. Install ngspice and/or set AIR_NGSPICE "
        f"to its path. Download: {_NGSPICE_INSTALL_URL}",
        [test_id],
        suggested_actions=[
            "Install ngspice (see docs/DEVELOPMENT.md environment table)",
            "Set AIR_NGSPICE=/path/to/ngspice in your .env if it is installed outside PATH",
        ],
    )


def run_ngspice(netlist: Path, log_path: Path, extra_options: list[str] | None = None) -> NgspiceRun:
    """Run ngspice in batch mode, returning a structured outcome.

    Returns ``NgspiceRun(attempted=False)`` when no ngspice binary is reachable
    (the legitimate fallback trigger). When ngspice runs, the real exit code and
    captured stdout/stderr are returned so the caller can tell a clean run from a
    hard failure instead of collapsing both into a single boolean.

    ``extra_options`` are convergence-aid ``.options`` tokens (issue #45's
    ladder). They are ADDED to the compiler's netlist for this one invocation:
    the base ``main.cir`` is never mutated (so rung 1 is always the design
    exactly as written, and the ladder is auditable), and a rung-specific netlist
    carrying the extra ``.options`` line is written alongside it and run instead.
    An empty/None list runs the unmodified base netlist (rung 1).
    """
    from .tools import ngspice_path

    ngspice = ngspice_path()
    if not ngspice:
        return NgspiceRun(attempted=False)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    run_netlist = netlist
    if extra_options:
        run_netlist = _write_ladder_netlist(netlist, extra_options)
    result = subprocess.run([ngspice, "-b", run_netlist.name], capture_output=True, text=True, cwd=run_netlist.parent)
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    return NgspiceRun(attempted=True, returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


def _write_ladder_netlist(netlist: Path, extra_options: list[str]) -> Path:
    """Write a rung-specific netlist = the base deck + one extra ``.options`` line.

    The extra ``.options`` line is inserted immediately after the compiler's
    ``.options filetype=ascii`` line (so it participates in the same OP/tran
    solve) without removing anything the compiler emitted. The base netlist is
    left untouched; the rung deck is written next to it as ``main.rung.cir`` so
    the exact deck each rung ran is inspectable after the fact.
    """
    text = netlist.read_text(encoding="utf-8")
    option_line = ".options " + " ".join(extra_options)
    lines = text.splitlines()
    inserted = False
    out_lines: list[str] = []
    for line in lines:
        out_lines.append(line)
        if not inserted and line.strip().lower().startswith(".options"):
            out_lines.append(option_line)
            inserted = True
    if not inserted:
        # No base .options line (defensive): prepend after the title comment.
        out_lines.insert(1 if out_lines else 0, option_line)
    rung_netlist = netlist.with_name("main.rung.cir")
    rung_netlist.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return rung_netlist


def _ngspice_failure_diagnostic(builder: DiagnosticBuilder, test_id: str, run: NgspiceRun) -> Diagnostic:
    """Build the structured diagnostic for a hard ngspice failure.

    Carries the exit code and the tail of ngspice's output (which names the
    cause, e.g. ``unknown model`` / ``no simulations run``) so the report is a
    truthful record of a simulation that did not run, not a silent DC pass.
    """
    tail = _ngspice_output_tail(run)
    return builder.make(
        "error",
        "simulation",
        "NGSPICE_FAILED",
        f"ngspice exited with code {run.returncode} for test {test_id}; the transient did not run.",
        [test_id],
        observed={"returncode": run.returncode, "stderr_tail": tail},
        suggested_actions=[
            "Inspect the generated netlist for undefined models/subcircuits",
            "Ensure every device line references a defined .model/.subckt",
            "Check the ngspice log for the failing line",
        ],
    )


@dataclass
class LadderOutcome:
    """Result of walking the convergence-aid ladder for one test.

    ``run`` / ``waveform_stats`` are the winning rung's outputs (or the last rung
    tried, on terminal failure). ``attempts`` is the ordered per-rung record that
    becomes the report's ``convergence.attempts``. ``winning_rung`` is the
    LadderRung that converged, or ``None`` when the ladder was exhausted or
    ngspice was never run (missing binary).
    """

    run: NgspiceRun
    waveform_stats: dict[str, SignalStats]
    attempts: list[dict[str, object]]
    winning_rung: LadderRung | None


def run_convergence_ladder(
    netlist: Path,
    log_path: Path,
    wave_dir: Path,
    test: Test,
    probe_nets: list[str],
) -> LadderOutcome:
    """Run the fixed convergence-aid ladder (issue #45), stopping at first success.

    Rung 1 is ALWAYS the netlist exactly as written. Each subsequent rung ADDS
    that rung's ``.options`` (see CONVERGENCE_LADDER / docs/convergence_ladder.md)
    and re-runs. A rung "converges" when ngspice exits 0 AND its transient
    produced readable waveform data; otherwise the ladder climbs to the next
    rung. Between rungs the probe waveforms are cleared so a later rung never
    reads a stale/partial CSV from an aborted earlier rung. The ladder is finite
    and deterministic — no randomness, no adaptive tuning.

    If ngspice is not installed (``run.attempted is False`` on rung 1), there is
    nothing to escalate: the ladder returns immediately with a single rung-1
    attempt marked ``ngspice_missing`` so the caller takes the documented DC
    fallback path. This keeps the ladder out of the ngspice-not-installed case.
    """
    attempts: list[dict[str, object]] = []
    last_run = NgspiceRun(attempted=False)
    last_stats: dict[str, SignalStats] = {}
    for rung in CONVERGENCE_LADDER:
        _clear_test_waveforms_explicit(wave_dir, test, probe_nets)
        run = run_ngspice(netlist, log_path, extra_options=list(rung.options))
        if not run.attempted:
            # No ngspice binary: not a convergence question at all. Record a
            # single rung-1 attempt and hand back to the DC-fallback path.
            attempts.append(
                {"rung": rung.rung, "name": rung.name, "options": list(rung.options),
                 "converged": False, "ngspice_missing": True}
            )
            return LadderOutcome(run=run, waveform_stats={}, attempts=attempts, winning_rung=None)
        stats = _read_ngspice_waveforms_explicit(wave_dir, test, probe_nets)
        converged = run.returncode == 0 and bool(stats)
        attempts.append(
            {"rung": rung.rung, "name": rung.name, "options": list(rung.options),
             "converged": converged}
        )
        last_run, last_stats = run, stats
        if converged:
            return LadderOutcome(run=run, waveform_stats=stats, attempts=attempts, winning_rung=rung)
    # Ladder exhausted: no rung converged. Hand back the last rung's run so the
    # existing NGSPICE_FAILED path still records the raw exit/stderr.
    return LadderOutcome(run=last_run, waveform_stats=last_stats, attempts=attempts, winning_rung=None)


def _convergence_section(outcome: LadderOutcome) -> dict[str, object]:
    """Serialize a LadderOutcome into the report's ``convergence`` object.

    Deterministic and JSON-plain (issue #45). ``aids_required`` (rung >= 2) is the
    flag the UI turns into the "numerical aids required" note and the flag the
    repair agent (#19) reads to know a rung>=2 success is NOT a design defect.
    ``terminal`` marks an exhausted ladder (topology-directed remediation, not
    raw stderr). When ngspice was never run (missing binary) the section is a
    single not-converged rung-1 attempt with no note — the DC-fallback path owns
    that case.
    """
    winning = outcome.winning_rung
    rung_no = winning.rung if winning else None
    aids_required = bool(winning and winning.rung >= 2)
    ngspice_ran = any(not a.get("ngspice_missing") for a in outcome.attempts)
    terminal = ngspice_ran and winning is None
    note: str | None = None
    if aids_required and winning is not None:
        note = (
            f"numerical aids required (rung {winning.rung}: {winning.name}); "
            "accuracy may be reduced - see docs/convergence_ladder.md"
        )
        if winning.relaxes:
            note += " (error tolerance was relaxed one notch to reach convergence)"
    elif terminal:
        note = (
            "did not converge after every numerical aid; this usually means a "
            "topology problem (floating node / missing DC path to ground), not a "
            "value problem - inspect the topology before adjusting values"
        )
    return {
        "attempts": outcome.attempts,
        "converged": winning is not None,
        "rung": rung_no,
        "aids_required": aids_required,
        "terminal": terminal,
        "note": note,
    }


def _terminal_convergence_diagnostic(builder: DiagnosticBuilder, test_id: str) -> Diagnostic:
    """Terminal convergence failure (SIM-010): the ladder was exhausted.

    A design that survives every numerical aid usually has a topology defect, not
    a value defect. The message/remediation are topology-directed (floating node
    / missing ground path), NOT the raw ngspice stderr (which NGSPICE_FAILED
    still carries for debugging). Rendered via the registry loader so the message
    and registry/diagnostics.json can never drift (docs/diagnostics_spec.md).
    """
    from .diagnostics_registry import render_message, severity_for

    code = "SIM-010"
    rungs = len(CONVERGENCE_LADDER)
    return builder.make(
        severity_for(code),
        "simulation",
        code,
        render_message(code, test_id=test_id, rungs=rungs),
        [test_id],
        observed={"ladder_rungs": rungs},
        suggested_actions=[
            "Check for floating nodes (a net reachable only through capacitors)",
            "Ensure every node has a DC path to ground",
            "Add the missing ground connection or a high-value bleeder resistor, then re-simulate",
        ],
    )


def _ngspice_output_tail(run: NgspiceRun, max_lines: int = 12, max_chars: int = 800) -> str:
    """Return a trimmed tail of ngspice's combined output identifying the cause.

    ngspice writes the operative error (``unknown model``, ``unknown subckt``,
    ``no simulations run``) at the end of its output. We keep the last few
    non-empty lines, deterministically, so the diagnostic pinpoints the cause
    without embedding the version banner or the full solver trace.
    """
    combined = (run.stdout or "") + (run.stderr or "")
    lines = [line.rstrip() for line in combined.splitlines() if line.strip()]
    tail = "\n".join(lines[-max_lines:])
    if len(tail) > max_chars:
        tail = tail[-max_chars:]
    return tail


def _measure_dc(ir: SystemIR, test: Test) -> dict[str, float]:
    measurements: dict[str, float] = {}
    known_voltages = {
        net: parse_quantity(value, "V")
        for net, value in test.setup.items()
        if not net.startswith("current:") and not net.startswith("load_step:")
    }
    for net in ir.nets.values():
        if net.id in known_voltages:
            measurements[net.id] = known_voltages[net.id]
        elif net.role == "ground":
            measurements[net.id] = 0.0

    for component in ir.components.values():
        if component.type == "voltage_source" and component.value and len(component.pins) >= 2:
            pins = list(component.pins.values())
            positive, negative = pins[0].net, pins[1].net
            try:
                voltage = parse_quantity(component.value, "V")
            except ValueError:
                continue
            if negative in measurements:
                measurements[positive] = measurements[negative] + voltage
            elif positive in measurements:
                measurements[negative] = measurements[positive] - voltage

    for component in ir.components.values():
        if component.type == "ldo":
            out_pin = component.pins.get("out")
            vout = component.properties.get("vout")
            if out_pin and vout:
                measurements[out_pin.net] = parse_quantity(vout, "V")

    changed = True
    while changed:
        changed = False
        for node, value in _solve_resistive_dividers(ir.components.values(), measurements).items():
            if node not in measurements or abs(measurements[node] - value) > 1e-9:
                measurements[node] = value
                changed = True
    for component in ir.components.values():
        if component.type == "generic_load":
            current = _test_current(test, component.id) or component.properties.get("current") or component.value
            step = _test_load_step(test, component.id)
            if step:
                current = step[1]
            if current:
                measurements[f"i({component.id})"] = parse_quantity(current, "A")
    return measurements


def _solve_resistive_dividers(components: list[Component] | object, known: dict[str, float]) -> dict[str, float]:
    resistors = [c for c in components if c.type == "resistor" and len(c.pins) >= 2 and c.value]
    unknowns = set()
    for resistor in resistors:
        for pin in resistor.pins.values():
            if pin.net not in known:
                unknowns.add(pin.net)
    solved: dict[str, float] = {}
    for net in unknowns:
        conductance_sum = 0.0
        weighted_voltage = 0.0
        for resistor in resistors:
            pins = list(resistor.pins.values())
            nets = [pins[0].net, pins[1].net]
            if net not in nets:
                continue
            other = nets[1] if nets[0] == net else nets[0]
            if other not in known:
                continue
            resistance = parse_quantity(resistor.value, "ohm")
            conductance = 1.0 / resistance
            conductance_sum += conductance
            weighted_voltage += conductance * known[other]
        if conductance_sum > 0:
            solved[net] = weighted_voltage / conductance_sum
    return solved


def _evaluate_assertions(test: Test, measured: dict[str, float], stats: dict[str, SignalStats]) -> list[Diagnostic]:
    builder = DiagnosticBuilder()
    diagnostics: list[Diagnostic] = []
    for assertion in test.assertions:
        op = assertion.get("op")
        if op not in {"assert_voltage", "assert_current"}:
            continue
        subject = assertion.get("net", "") if op == "assert_voltage" else f"i({assertion.get('component', '')})"
        unit = "V" if op == "assert_voltage" else "A"
        value = measured.get(subject)
        signal_stats = stats.get(subject)
        min_value = parse_quantity(assertion.get("min", "-1e99" + unit), unit)
        max_value = parse_quantity(assertion.get("max", "1e99" + unit), unit)
        if value is None:
            diagnostics.append(builder.make("error", "analog", "ASSERT_NO_MEASUREMENT", f"No measurement available for {subject}.", [test.id, subject]))
            continue
        observed_min = signal_stats.min if signal_stats else value
        observed_max = signal_stats.max if signal_stats else value
        if observed_min < min_value or observed_max > max_value:
            diagnostics.append(
                builder.make(
                    "error",
                    "analog",
                    "ASSERT_FAILED",
                    f"{subject} was outside expected range.",
                    [test.id, subject],
                    observed={
                        "final": format_quantity(value, unit),
                        "min": format_quantity(observed_min, unit),
                        "max": format_quantity(observed_max, unit),
                        **(
                            {
                                "time_of_min": f"{signal_stats.time_of_min:.9g}s",
                                "time_of_max": f"{signal_stats.time_of_max:.9g}s",
                            }
                            if signal_stats
                            else {}
                        ),
                    },
                    expected={"min": assertion.get("min"), "max": assertion.get("max")},
                    suggested_actions=["Adjust component values", "Check source/load setup", "Check expected assertion limits"],
                )
            )
    return diagnostics


def _write_waveforms(wave_dir: Path, test: Test, measured: dict[str, float], nets: list[str] | None = None) -> None:
    wave_dir.mkdir(parents=True, exist_ok=True)
    process_nets = nets if nets is not None else [a.get("net", "") for a in test.assertions if a.get("op") == "assert_voltage" and a.get("net")]
    for net in process_nets:
        if net not in measured:
            continue
        path = wave_dir / f"{test.id}_{net}.csv"
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["time_s", f"v({net})"])
            writer.writerow([0.0, measured[net]])
            writer.writerow([_duration_seconds(test.duration), measured[net]])


def _clear_test_waveforms_explicit(wave_dir: Path, test: Test, nets: list[str]) -> None:
    for net in nets:
        path = wave_dir / f"{test.id}_{net}.csv"
        if path.exists():
            path.unlink()


def _read_samples(path: Path) -> list[tuple[float, float]]:
    """Parse a waveform CSV into (time, value) pairs.

    Handles both ngspice ``wrdata`` output (whitespace-delimited, no header,
    e.g. ` 0.00000000e+00  1.04210526e+00 `) and our canonical comma format with
    a ``time_s,v(net)`` header. Header / non-numeric lines yield no numbers and
    are skipped. The last two numbers on a line are taken as the time/value pair.
    """
    samples: list[tuple[float, float]] = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return samples
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        numbers: list[float] = []
        for token in line.replace(",", " ").split():
            try:
                numbers.append(float(token))
            except ValueError:
                pass
        if len(numbers) >= 2:
            samples.append((numbers[-2], numbers[-1]))
    return samples


def _read_ngspice_waveforms_explicit(wave_dir: Path, test: Test, nets: list[str]) -> dict[str, SignalStats]:
    measurements: dict[str, SignalStats] = {}
    for net in nets:
        samples = _read_samples(wave_dir / f"{test.id}_{net}.csv")
        if samples:
            measurements[net] = _stats_for_samples(samples, "V")
    return measurements


def _write_canonical_waveform(path: Path, net: str, samples: list[tuple[float, float]], max_points: int = 500) -> None:
    """Rewrite a waveform CSV in the canonical ``time_s,v(net)`` comma format
    (the shape the UI/readback expect), downsampled to keep transient files small
    while preserving the final sample."""
    if len(samples) > max_points:
        step = len(samples) // max_points
        reduced = samples[::step]
        if reduced[-1] != samples[-1]:
            reduced.append(samples[-1])
        samples = reduced
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["time_s", f"v({net})"])
        for time_s, value in samples:
            writer.writerow([time_s, value])


def _stats_for_samples(samples: list[tuple[float, float]], unit: str) -> SignalStats:
    final = samples[-1][1]
    min_time, min_value = min(samples, key=lambda item: item[1])
    max_time, max_value = max(samples, key=lambda item: item[1])
    return SignalStats(
        final=final,
        min=min_value,
        max=max_value,
        time_of_min=min_time,
        time_of_max=max_time,
        unit=unit,
    )


def _stats_from_measurements(measured: dict[str, float]) -> dict[str, SignalStats]:
    return {
        name: SignalStats(final=value, min=value, max=value, time_of_min=0.0, time_of_max=0.0, unit=_unit_for_signal(name))
        for name, value in measured.items()
    }


def _serialize_stats(stats: dict[str, SignalStats]) -> dict[str, dict[str, str]]:
    return {
        name: {
            "final": format_quantity(signal.final, signal.unit),
            "min": format_quantity(signal.min, signal.unit),
            "max": format_quantity(signal.max, signal.unit),
            "time_of_min": f"{signal.time_of_min:.9g}s",
            "time_of_max": f"{signal.time_of_max:.9g}s",
        }
        for name, signal in stats.items()
    }


def _unit_for_signal(name: str) -> str:
    return "A" if name.startswith("i(") else "V"


def _test_current(test: Test, component_id: str) -> str | None:
    return test.setup.get(f"current:{component_id}")


def _test_load_step(test: Test, component_id: str) -> tuple[str, str, str, str] | None:
    encoded = test.setup.get(f"load_step:{component_id}")
    if not encoded:
        return None
    parts = encoded.split(",")
    if len(parts) != 4 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1], parts[2], parts[3]


def _duration_seconds(duration: str) -> float:
    if not duration:
        return 0.1
    return parse_quantity(duration, "s")


