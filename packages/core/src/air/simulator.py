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
        
        # Merge extra probes with assertion-based probes for cleanup and stats
        assertion_nets = {a.get("net", "") for a in test.assertions if a.get("op") == "assert_voltage" and a.get("net")}
        all_probe_nets = sorted(assertion_nets | extra_probe_nets)
        
        _clear_test_waveforms_explicit(out_dir / "waveforms", test, all_probe_nets)
        compile_result = compile_spice(ir, out_dir, test, extra_probes=list(extra_probe_nets))
        ran_ngspice = run_ngspice(out_dir / "spice" / "main.cir", out_dir / "reports" / f"{test.id}.ngspice.log")
        measured = _measure_dc(ir, test)
        stats = _stats_from_measurements(measured)
        waveform_stats = _read_ngspice_waveforms_explicit(out_dir / "waveforms", test, all_probe_nets)
        if waveform_stats:
            stats.update(waveform_stats)
            measured.update({name: signal.final for name, signal in waveform_stats.items()})
        # Only credit ngspice when its transient actually produced readable data;
        # a clean exit with no waveforms still means the numbers came from the
        # builtin DC solver, so the backend label must say so.
        used_ngspice = ran_ngspice and bool(waveform_stats)
        if used_ngspice:
            # ngspice wrote whitespace-delimited wrdata; normalize each probe CSV
            # into the canonical comma+header form the UI/readback consume.
            for net in all_probe_nets:
                wave_path = out_dir / "waveforms" / f"{test.id}_{net}.csv"
                samples = _read_samples(wave_path)
                if samples:
                    _write_canonical_waveform(wave_path, net, samples)
        diagnostics = _evaluate_assertions(test, measured, stats)
        if diagnostics:
            status = "failed"
        report_diagnostics = diagnostics + compile_result.diagnostics
        if ngspice_missing and not used_ngspice:
            report_diagnostics = report_diagnostics + [_ngspice_missing_diagnostic(missing_diag_builder, test.id)]
        waveform_artifacts = [str(out_dir / "waveforms" / f"{test.id}_{net}.csv") for net in all_probe_nets]
        report = {
            "profile": profile_id,
            "test": test.id,
            "status": "failed" if diagnostics else "passed",
            "backend": "ngspice" if used_ngspice else "builtin_dc_fallback",
            "measurements": {name: format_quantity(value, _unit_for_signal(name)) for name, value in measured.items()},
            "measurement_stats": _serialize_stats(stats),
            "diagnostics": [d.to_dict() for d in report_diagnostics],
            "artifacts": [artifact.path for artifact in compile_result.artifacts] + waveform_artifacts,
        }
        report_path = out_dir / "reports" / f"{test.id}.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        if not used_ngspice:
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


def run_ngspice(netlist: Path, log_path: Path) -> bool:
    from .tools import ngspice_path

    ngspice = ngspice_path()
    if not ngspice:
        return False
    log_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run([ngspice, "-b", netlist.name], capture_output=True, text=True, cwd=netlist.parent)
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    return result.returncode == 0


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


