"""<gui> hint parser + canonicalizer + model_dump tests (issue #22 B).

Verifies the Python oracle's handling of the optional
``<gui x=".." y=".." rot=".."/>`` child on a ``<component>``:

  1. parse_string reads the attributes into ``Component.gui`` (float/int),
     or leaves ``gui=None`` when the child is absent.
  2. canonicalize_tree moves the ``<gui>`` child to sit AFTER the last
     ``<pin>`` element within the component, so an author who dropped it at
     the front (in isolation, or via a patch) canonicalizes identically to
     one who wrote it last.
  3. model_to_dict OMITS the ``gui`` key entirely when the hint is None --
     which is what preserves byte-parity with the frozen pre-#22 model.json
     corpus fixtures (same pattern as Test.analysis in #62).
  4. Round-trip: parse -> canonicalize -> parse preserves the hint.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from air.canonicalizer import canonicalize_tree
from air.model_dump import model_to_dict
from air.parser import parse_string


DESIGN_WITH_GUI = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<system name=\"hint_demo\" ir_version=\"0.1\">
  <metadata><title>t</title></metadata>
  <nets>
    <net id=\"gnd\" role=\"ground\"/>
    <net id=\"vcc\" role=\"power\"/>
  </nets>
  <components>
    <component id=\"R1\" type=\"resistor\">
      <value>10k</value>
      <pin name=\"1\" net=\"vcc\"/>
      <pin name=\"2\" net=\"gnd\"/>
      <gui x=\"120\" y=\"240\" rot=\"0\"/>
    </component>
    <component id=\"R2\" type=\"resistor\">
      <gui x=\"480\" y=\"240\"/>
      <value>4k7</value>
      <pin name=\"1\" net=\"vcc\"/>
      <pin name=\"2\" net=\"gnd\"/>
    </component>
  </components>
  <tests>
    <test id=\"t1\">
      <setup><set_voltage net=\"vcc\" value=\"5V\"/></setup>
      <run duration=\"1ms\"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id=\"only\" default=\"true\"><run test=\"t1\"/></profile>
  </simulation_profiles>
</system>"""

DESIGN_WITHOUT_GUI = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<system name=\"no_hint\" ir_version=\"0.1\">
  <metadata><title>t</title></metadata>
  <nets>
    <net id=\"gnd\" role=\"ground\"/>
    <net id=\"vcc\" role=\"power\"/>
  </nets>
  <components>
    <component id=\"R1\" type=\"resistor\">
      <value>10k</value>
      <pin name=\"1\" net=\"vcc\"/>
      <pin name=\"2\" net=\"gnd\"/>
    </component>
  </components>
  <tests>
    <test id=\"t1\">
      <setup><set_voltage net=\"vcc\" value=\"5V\"/></setup>
      <run duration=\"1ms\"/>
    </test>
  </tests>
  <simulation_profiles>
    <profile id=\"only\" default=\"true\"><run test=\"t1\"/></profile>
  </simulation_profiles>
</system>"""


def test_parse_gui_hint():
    ir, _ = parse_string(DESIGN_WITH_GUI)
    r1 = ir.components["R1"]
    r2 = ir.components["R2"]
    assert r1.gui is not None
    assert r1.gui.x == 120.0 and r1.gui.y == 240.0 and r1.gui.rot == 0
    # R2 omits rot -> defaults to 0.
    assert r2.gui is not None
    assert r2.gui.x == 480.0 and r2.gui.y == 240.0 and r2.gui.rot == 0


def test_absent_gui_is_none():
    ir, _ = parse_string(DESIGN_WITHOUT_GUI)
    assert ir.components["R1"].gui is None


def test_model_dump_omits_gui_when_none():
    without_ir, _ = parse_string(DESIGN_WITHOUT_GUI)
    dumped = model_to_dict(without_ir)
    assert "gui" not in dumped["components"]["R1"]
    with_ir, _ = parse_string(DESIGN_WITH_GUI)
    dumped_with = model_to_dict(with_ir)
    assert dumped_with["components"]["R1"]["gui"] == {"x": 120.0, "y": 240.0, "rot": 0}


def test_canonicalizer_places_gui_after_pins():
    _, tree = parse_string(DESIGN_WITH_GUI)
    canon = canonicalize_tree(tree)
    r2 = _slice(canon, '<component id="R2"', "</component>")
    order = ["<value>", "<pin ", "<pin ", "<gui "]
    cursor = 0
    for token in order:
        idx = r2.find(token, cursor)
        assert idx > -1, f"missing {token!r} at/after {cursor} in\n{r2}"
        cursor = idx + len(token)


def test_canonical_gui_attributes_are_sorted():
    _, tree = parse_string(DESIGN_WITH_GUI)
    canon = canonicalize_tree(tree)
    # rot, x, y (alphabetical) is what _sort_attributes produces.
    assert '<gui rot="0" x="120" y="240"/>' in canon


def test_roundtrip_preserves_gui():
    ir1, tree = parse_string(DESIGN_WITH_GUI)
    canon = canonicalize_tree(tree)
    ir2, _ = parse_string(canon)
    assert ir2.components["R1"].gui == ir1.components["R1"].gui
    assert ir2.components["R2"].gui == ir1.components["R2"].gui


def _slice(text: str, start_tag: str, end_tag: str) -> str:
    start = text.index(start_tag)
    end = text.index(end_tag, start)
    return text[start : end + len(end_tag)]
