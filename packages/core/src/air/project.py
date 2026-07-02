from __future__ import annotations

from dataclasses import dataclass, asdict
import json
from pathlib import Path


PROJECT_FILE = "air.project.json"


@dataclass(frozen=True)
class AirProject:
    name: str
    design: str = "design.air.xml"
    generated_dir: str = "generated"
    default_profile: str = "analog_only"
    registry_paths: list[str] | None = None
    enabled_backends: list[str] | None = None

    def to_dict(self) -> dict[str, object]:
        data = asdict(self)
        data["registry_paths"] = self.registry_paths or ["registry"]
        data["enabled_backends"] = self.enabled_backends or ["ngspice", "firmware", "renode"]
        return data


def write_project(path: Path, project: AirProject) -> Path:
    project_file = path / PROJECT_FILE
    project_file.write_text(json.dumps(project.to_dict(), indent=2) + "\n", encoding="utf-8")
    return project_file


def load_project(path: Path) -> tuple[AirProject, Path]:
    project_file = path if path.name == PROJECT_FILE else path / PROJECT_FILE
    data = json.loads(project_file.read_text(encoding="utf-8"))
    return (
        AirProject(
            name=data.get("name", project_file.parent.name),
            design=data.get("design", "design.air.xml"),
            generated_dir=data.get("generated_dir", "generated"),
            default_profile=data.get("default_profile", "analog_only"),
            registry_paths=data.get("registry_paths", ["registry"]),
            enabled_backends=data.get("enabled_backends", ["ngspice", "firmware", "renode"]),
        ),
        project_file.parent,
    )


def resolve_design(design: str | None, project_path: str | None = None) -> tuple[Path, Path, str]:
    if project_path:
        project, root = load_project(Path(project_path))
        return root / project.design if design is None else Path(design), root / project.generated_dir, project.default_profile
    if design is None:
        cwd_project = Path.cwd() / PROJECT_FILE
        if cwd_project.exists():
            project, root = load_project(cwd_project)
            return root / project.design, root / project.generated_dir, project.default_profile
        raise ValueError("A design path is required when no air.project.json is available.")
    return Path(design), Path("generated"), "analog_only"

