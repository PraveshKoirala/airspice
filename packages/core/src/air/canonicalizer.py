from __future__ import annotations

import uuid
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


# Firmware inline source (issue #36) must survive canonicalization BYTE-EXACT and
# be re-emitted as CDATA -- but the minidom.toprettyxml + blank-line-strip pipeline
# below would reindent text and DROP blank lines inside the program, corrupting the
# user's code. So we do NOT let the source text flow through that pipeline. Before
# serializing we swap each <firmware>/<source> text for a unique one-line ASCII
# MARKER (which pretty-prints inline as <source>MARKER</source> and survives the
# blank-line strip); AFTER the strip+join we substitute the marker for the raw
# source wrapped in CDATA, split-escaping any literal "]]>" as "]]]]><![CDATA[>" so
# it round-trips. The marker is random per call and asserted absent from the source,
# so it can never collide with real program text. This keeps determinism (the marker
# is gone from the output) and byte-exactness (blank lines / tabs / trailing spaces
# / unicode all preserved). Mirrored byte-for-byte by
# packages/air-ts/src/canonicalizer.ts.
_CDATA_OPEN = "<![CDATA["
_CDATA_CLOSE = "]]>"


def _escape_cdata(source: str) -> str:
    """Split-escape a literal ``]]>`` so ``source`` is safe inside one CDATA run.

    ``]]>`` becomes ``]]]]><![CDATA[>`` -- the first CDATA run ends after ``]]``,
    a new one opens, and ``>`` continues it. Re-parsing concatenates the runs back
    to the original bytes.
    """
    return source.replace(_CDATA_CLOSE, "]]]]><![CDATA[>")


def canonicalize_tree(tree: ET.ElementTree) -> str:
    root = deepcopy(tree.getroot())
    # Markerize <firmware>/<source> text (issue #36) before the pretty pipeline.
    source_substitutions: dict[str, str] = {}
    for firmware_el in root.iter("firmware"):
        for source_el in list(firmware_el):
            if source_el.tag != "source":
                continue
            raw = source_el.text if source_el.text is not None else ""
            marker = "AIRSPICEFWSRC" + uuid.uuid4().hex
            # Astronomically unlikely, but keep the invariant honest.
            assert marker not in raw
            source_substitutions[marker] = _CDATA_OPEN + _escape_cdata(raw) + _CDATA_CLOSE
            source_el.text = marker
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
    result = "\n".join(lines) + "\n"
    # Re-inject byte-exact firmware source AFTER the blank-line strip so blank
    # lines inside the program survive (issue #36). The marker line was
    # <source>MARKER</source>; it becomes <source><![CDATA[...]]></source>.
    for marker, cdata in source_substitutions.items():
        result = result.replace(marker, cdata)
    return result


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

