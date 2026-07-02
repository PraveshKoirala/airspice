from __future__ import annotations

from copy import deepcopy
from xml.etree import ElementTree as ET


def normalize_air_tree(tree: ET.ElementTree) -> ET.ElementTree:
    root = deepcopy(tree.getroot())
    if root.tag != "system":
        return ET.ElementTree(root)
    _coerce_structure(root)
    _normalize_nets(root)
    _normalize_components(root)
    _normalize_simulation_profiles(root)
    return ET.ElementTree(root)


def _coerce_structure(root: ET.Element) -> None:
    """Absorb the common ways an LLM deviates from the AIR shape, applied before
    any semantic normalization: identifier-bearing elements that use ``name``
    instead of ``id``, and components that wrap their pins in a ``<pins>``
    container instead of listing them directly."""
    for path in ("./nets/net", "./components/component", "./tests/test", "./simulation_profiles/profile"):
        for element in root.findall(path):
            if "id" not in element.attrib and "name" in element.attrib:
                element.attrib["id"] = element.attrib["name"]
    for component in root.findall("./components/component"):
        wrapper = component.find("pins")
        if wrapper is not None:
            for pin in list(wrapper.findall("pin")):
                component.append(pin)
            component.remove(wrapper)


def normalize_air_xml(xml_text: str) -> ET.ElementTree:
    return normalize_air_tree(ET.ElementTree(ET.fromstring(xml_text)))


def _normalize_nets(root: ET.Element) -> None:
    components = {component.attrib.get("id", ""): component for component in root.findall("./components/component")}
    for net in root.findall("./nets/net"):
        net_id = net.attrib.get("id", "")
        if not net_id:
            continue
        net.attrib.setdefault("role", _infer_net_role(net_id))
        for node in net.findall("node"):
            component = components.get(node.attrib.get("component", ""))
            pin_name = node.attrib.get("pin", "")
            if component is None or not pin_name:
                continue
            normalized_pin = _normalize_pin_name(component.attrib.get("type", ""), pin_name)
            if not any(pin.attrib.get("name") == normalized_pin for pin in component.findall("pin")):
                ET.SubElement(component, "pin", {"name": normalized_pin, "net": net_id})


def _known_component_types() -> set[str]:
    from .registry import COMPONENT_SPECS

    return set(COMPONENT_SPECS) | {"mcu", "sensor", "battery"}


def _normalize_components(root: ET.Element) -> None:
    known_types = _known_component_types()
    for component in root.findall("./components/component"):
        component_type = component.attrib.get("type", "")
        # Common LLM variant: the component type is placed in 'part' (e.g.
        # part="resistor") with no 'type'. Coerce when 'part' names a known type;
        # leave real part numbers (type="ldo" part="LM1117") untouched.
        if not component_type:
            part = component.attrib.get("part", "")
            if part and part.lower() in known_types:
                component_type = part.lower()
                component.attrib["type"] = component_type
                del component.attrib["part"]

        for pin in component.findall("pin"):
            if "name" in pin.attrib:
                pin.attrib["name"] = _normalize_pin_name(component_type, pin.attrib["name"])
            if "net" not in pin.attrib:
                net = pin.attrib.get("node") or pin.attrib.get("ref")
                if net:
                    pin.attrib["net"] = net

        if component.find("value") is None:
            value = _value_from_parameters(component)
            if value:
                value_el = ET.Element("value")
                value_el.text = value
                first_pin = component.find("pin")
                children = list(component)
                insert_at = children.index(first_pin) if first_pin is not None else 0
                component.insert(insert_at, value_el)

        if component_type == "bjt":
            transistor_type = _parameter_value(component, "type")
            if transistor_type and "spice_model" not in component.attrib:
                component.attrib["spice_model"] = "PNP" if transistor_type.lower() == "pnp" else "NPN"


def _normalize_simulation_profiles(root: ET.Element) -> None:
    profiles_el = root.find("simulation_profiles")
    if profiles_el is None:
        return
    test_ids = [test.attrib.get("id", "") for test in root.findall("./tests/test") if test.attrib.get("id")]
    analog_ids = [sub.attrib.get("id", "") for sub in root.findall("./analog/subsystem") if sub.attrib.get("id")]
    for child in list(profiles_el):
        if child.tag == "simulation_profile":
            child.tag = "profile"
        if child.tag != "profile":
            continue
        solver = child.attrib.pop("solver", "")
        if solver and child.find("backend") is None:
            ET.SubElement(child, "backend", {"type": solver})
        # An analog profile with no backend can't simulate; default to ngspice.
        if child.find("backend") is None:
            ET.SubElement(child, "backend", {"type": "ngspice"})
        if not child.findall("run"):
            for test_id in test_ids:
                ET.SubElement(child, "run", {"test": test_id})
        if not child.findall("include"):
            for analog_id in analog_ids:
                ET.SubElement(child, "include", {"subsystem": analog_id})


def _value_from_parameters(component: ET.Element) -> str:
    component_type = component.attrib.get("type", "")
    candidates = {
        "resistor": ("resistance", "value"),
        "capacitor": ("capacitance", "value"),
        "voltage_source": ("voltage", "value"),
        "current_source": ("current", "value"),
        "generic_load": ("current", "resistance", "value"),
    }.get(component_type, ("value",))
    for name in candidates:
        value = _parameter_value(component, name)
        if value:
            return _with_default_unit(value, component_type, name)
    return ""


def _parameter_value(component: ET.Element, name: str) -> str:
    for parameter in component.findall("parameter"):
        if parameter.attrib.get("name", "").lower() == name.lower():
            return parameter.attrib.get("value", "")
    return ""


def _with_default_unit(value: str, component_type: str, parameter_name: str) -> str:
    stripped = value.strip()
    if any(ch.isalpha() for ch in stripped):
        return stripped
    if component_type == "voltage_source":
        return f"{stripped}V"
    if component_type == "current_source" or parameter_name == "current":
        return f"{stripped}A"
    if component_type == "capacitor":
        return f"{stripped}F"
    return stripped


def _normalize_pin_name(component_type: str, pin_name: str) -> str:
    if component_type in {"bjt", "mosfet"}:
        return pin_name.upper()
    return pin_name


def _infer_net_role(net_id: str) -> str:
    normalized = net_id.lower()
    if normalized in {"gnd", "ground", "0", "vss"}:
        return "ground"
    if normalized in {"vcc", "vdd", "vin", "bat", "battery", "3v3", "5v", "+3v3", "+5v"}:
        return "power"
    return "analog_signal"
