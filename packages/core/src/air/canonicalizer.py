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
        if section.tag == "components":
            for component in section:
                _order_component_children(component)
    rough = ET.tostring(root, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ")
    lines = [line for line in pretty.splitlines() if line.strip()]
    return "\n".join(lines) + "\n"


def _sort_attributes(element: ET.Element) -> None:
    element.attrib = dict(sorted(element.attrib.items()))
    for child in element:
        _sort_attributes(child)


# Canonical position of the optional <gui> child within a <component>
# (issue #22). The rule is deliberately MINIMAL to keep the pre-#22 corpus
# byte-identical: only <gui> children are relocated -- everything else
# retains document order. A <gui> child is moved so it appears IMMEDIATELY
# AFTER the last <pin> child (or, if the component has no <pin>, after
# <value>; failing that, at the front). This makes the <gui> position
# deterministic across "add a hint by hand-edit" vs "add a hint via
# patch", without perturbing any existing corpus canonical.
# Documented in schemas/air.xsd on the <gui> element definition; mirrored
# by packages/air-ts/src/canonicalizer.ts.


def _order_component_children(component: ET.Element) -> None:
    """Move any <gui> children to the canonical slot (after last <pin>)."""
    gui_children = [child for child in component if child.tag == "gui"]
    if not gui_children:
        return
    others = [child for child in component if child.tag != "gui"]
    # Insert after the last <pin> in `others`; fall back to after last
    # <value>; then to index 0.
    insert_after = -1
    for index, child in enumerate(others):
        if child.tag == "pin":
            insert_after = index
    if insert_after == -1:
        for index, child in enumerate(others):
            if child.tag == "value":
                insert_after = index
    ordered = others[: insert_after + 1] + gui_children + others[insert_after + 1 :]
    component[:] = ordered

