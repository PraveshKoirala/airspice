from __future__ import annotations

from copy import deepcopy
from xml.dom import minidom
from xml.etree import ElementTree as ET


SECTION_ORDER = [
    "metadata",
    "requirements",
    "nets",
    "power_domains",
    "components",
    "interfaces",
    "analog",
    "digital",
    "firmware",
    "bridges",
    "tests",
    "simulation_profiles",
    "exports",
    "gui",
]


def canonicalize_tree(tree: ET.ElementTree) -> str:
    root = deepcopy(tree.getroot())
    _sort_attributes(root)
    sections = list(root)
    ordered = []
    for section_name in SECTION_ORDER:
        ordered.extend([section for section in sections if section.tag == section_name])
    ordered.extend([section for section in sections if section.tag not in SECTION_ORDER])
    root[:] = ordered
    for section in root:
        if section.tag in {"nets", "power_domains", "components", "interfaces", "tests", "simulation_profiles"}:
            section[:] = sorted(section, key=lambda child: child.attrib.get("id", child.tag))
    rough = ET.tostring(root, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ")
    lines = [line for line in pretty.splitlines() if line.strip()]
    return "\n".join(lines) + "\n"


def _sort_attributes(element: ET.Element) -> None:
    element.attrib = dict(sorted(element.attrib.items()))
    for child in element:
        _sort_attributes(child)

