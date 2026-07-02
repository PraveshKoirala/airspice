from __future__ import annotations

import csv
from pathlib import Path


def list_waveforms(out_dir: Path) -> dict[str, object]:
    wave_dir = out_dir / "waveforms"
    items = []
    if wave_dir.exists():
        for path in sorted(wave_dir.glob("*.csv")):
            items.append(_waveform_summary(path))
    return {"success": True, "out_dir": str(out_dir), "waveforms": items}


def read_waveform(out_dir: Path, name: str) -> dict[str, object]:
    safe_name = Path(name).name
    path = out_dir / "waveforms" / safe_name
    if not path.exists() or path.suffix.lower() != ".csv":
        return {"success": False, "error": f"Waveform not found: {safe_name}", "points": []}
    summary = _waveform_summary(path)
    points = _read_points(path)
    return {**summary, "success": True, "points": points}


def _waveform_summary(path: Path) -> dict[str, object]:
    stem = path.stem
    signal = _signal_from_header(path) or stem
    test = stem[: -(len(signal) + 1)] if stem.endswith(f"_{signal}") else ""
    points = _read_points(path, limit=2)
    first = points[0] if points else None
    last = points[-1] if points else None
    return {
        "name": path.name,
        "path": str(path),
        "test": test,
        "signal": signal,
        "quantity": "voltage" if signal and not signal.startswith("i(") else "current",
        "first": first,
        "last": last,
    }


def _read_points(path: Path, limit: int | None = None) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader, [])
        for row in reader:
            values = []
            for item in row:
                try:
                    values.append(float(item))
                except ValueError:
                    pass
            if len(values) >= 2:
                points.append({"time_s": values[-2], "value": values[-1]})
                if limit is not None and len(points) >= limit:
                    break
    return points


def _signal_from_header(path: Path) -> str | None:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            header = next(csv.reader(handle), [])
    except OSError:
        return None
    if len(header) < 2:
        return None
    label = header[1].strip()
    if label.startswith("v(") and label.endswith(")"):
        return label[2:-1]
    if label.startswith("i(") and label.endswith(")"):
        return label
    return label or None
