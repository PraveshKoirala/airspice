from __future__ import annotations

from pathlib import Path
import xml.etree.ElementTree as ET

from .model import (
    AnalogSubsystem,
    Bridge,
    Component,
    ExportTarget,
    FirmwareBinding,
    FirmwareProject,
    FirmwareTask,
    Interface,
    Metadata,
    Net,
    PinConnection,
    PowerDomain,
    Probe,
    SimulationProfile,
    SystemIR,
    Test,
)
from .normalizer import normalize_air_tree


def parse_file(path: Path) -> tuple[SystemIR, ET.ElementTree]:
    tree = ET.parse(path)
    return parse_tree(tree), tree


def parse_string(xml_text: str) -> tuple[SystemIR, ET.ElementTree]:
    root = ET.fromstring(xml_text)
    tree = ET.ElementTree(root)
    return parse_tree(tree), tree


def parse_tree(tree: ET.ElementTree) -> SystemIR:
    tree = normalize_air_tree(tree)
    root = tree.getroot()
    if root.tag != "system":
        raise ValueError("AIR document root must be <system>")

    metadata_el = root.find("metadata")
    metadata = Metadata(
        title=_text(metadata_el, "title"),
        description=_text(metadata_el, "description"),
        author=_text(metadata_el, "author"),
        created_at=_text(metadata_el, "created_at"),
    )

    nets = {
        net.attrib["id"]: Net(
            id=net.attrib["id"],
            role=net.attrib.get("role", ""),
            nominal_voltage=net.attrib.get("nominal_voltage"),
        )
        for net in root.findall("./nets/net")
        if "id" in net.attrib
    }

    power_domains = {
        domain.attrib["id"]: PowerDomain(
            id=domain.attrib["id"],
            net=domain.attrib.get("net", ""),
            nominal=domain.attrib.get("nominal"),
            source=domain.attrib.get("source"),
        )
        for domain in root.findall("./power_domains/domain")
        if "id" in domain.attrib
    }

    components: dict[str, Component] = {}
    for element in root.findall("./components/component"):
        component_id = element.attrib.get("id", "")
        pins = {
            pin.attrib.get("name", ""): PinConnection(
                name=pin.attrib.get("name", ""),
                net=pin.attrib.get("net") or pin.attrib.get("node") or pin.attrib.get("ref") or "",
                function=pin.attrib.get("function"),
            )
            for pin in element.findall("pin")
        }
        properties = {
            prop.attrib.get("name", ""): prop.attrib.get("value", "")
            for prop in element.findall("property")
        }
        value_el = element.find("value")
        components[component_id] = Component(
            id=component_id,
            type=element.attrib.get("type", ""),
            part=element.attrib.get("part"),
            spice_model=element.attrib.get("spice_model"),
            spice_subckt=element.attrib.get("spice_subckt"),
            value=value_el.text.strip() if value_el is not None and value_el.text else None,
            pins=pins,
            properties=properties,
        )

    analog = []
    for subsystem in root.findall("./analog/subsystem"):
        analog.append(
            AnalogSubsystem(
                id=subsystem.attrib.get("id", ""),
                uses=[u.attrib.get("component", "") for u in subsystem.findall("uses")],
                probes=[
                    Probe(
                        id=p.attrib.get("id", ""),
                        net=p.attrib.get("net", ""),
                        quantity=p.attrib.get("quantity", ""),
                    )
                    for p in subsystem.findall("probe")
                ],
            )
        )

    interfaces = {}
    for iface in root.findall("./interfaces/interface"):
        data: dict[str, object] = {}
        for child in iface:
            value = dict(child.attrib)
            existing = data.get(child.tag)
            if existing is None:
                data[child.tag] = value
            elif isinstance(existing, list):
                existing.append(value)
            else:
                data[child.tag] = [existing, value]
        interfaces[iface.attrib.get("id", "")] = Interface(
            id=iface.attrib.get("id", ""),
            type=iface.attrib.get("type", ""),
            data=data,
        )

    firmware_projects = {}
    firmware_bindings = {}
    firmware_tasks = {}
    firmware_el = root.find("firmware")
    if firmware_el is not None:
        for project in firmware_el.findall("project"):
            project_id = project.attrib.get("id", "")
            firmware_projects[project_id] = FirmwareProject(
                id=project_id,
                target=project.get("target", ""),
                framework=project.get("framework", ""),
                language=project.get("language", ""),
                board=_text(project, "board"),
                source_tree=project.get("source_tree", ""),
            )
        for binding in firmware_el.findall("binding"):
            binding_id = binding.attrib.get("id", "")
            firmware_bindings[binding_id] = FirmwareBinding(
                id=binding_id,
                signal=_child_attr(binding, "signal", "name"),
                component=_child_attr(binding, "component", "ref"),
                peripheral=_text(binding, "peripheral"),
                channel=_text(binding, "channel"),
                net=_text(binding, "net"),
            )
        for task in firmware_el.findall("task"):
            task_id = task.attrib.get("id", "")
            operations = [
                {**{"op": child.tag}, **dict(child.attrib), **({"text": child.text.strip()} if child.text and child.text.strip() else {})}
                for child in task
                if child.tag != "period"
            ]
            firmware_tasks[task_id] = FirmwareTask(
                id=task_id,
                target=task.attrib.get("target", ""),
                period=_text(task, "period"),
                operations=operations,
            )

    bridges = []
    for b in root.findall("./bridges/bridge"):
        bridge_data = dict(b.attrib)
        for child in b:
            bridge_data[child.tag] = child.attrib
        bridges.append(Bridge(id=b.attrib.get("id", ""), type=b.attrib.get("type", ""), data=bridge_data))

    tests = {}
    for test in root.findall("./tests/test"):
        test_id = test.attrib.get("id", "")
        setup = {}
        for child in test.findall("./setup/*"):
            if child.tag == "set_voltage":
                setup[child.attrib.get("net", child.tag)] = child.attrib.get("value", "")
            elif child.tag == "set_current":
                setup[f"current:{child.attrib.get('component', '')}"] = child.attrib.get("value", "")
            elif child.tag == "load_step":
                component = child.attrib.get("component", "")
                setup[f"load_step:{component}"] = ",".join(
                    [
                        child.attrib.get("from", ""),
                        child.attrib.get("to", ""),
                        child.attrib.get("at", "0s"),
                        child.attrib.get("rise", "1us"),
                    ]
                )
            else:
                setup[child.attrib.get("net", child.tag)] = child.attrib.get("value", "")
        assertions = [dict(assertion.attrib, op=assertion.tag) for assertion in test if assertion.tag.startswith("assert_")]
        run = test.find("run")
        tests[test_id] = Test(
            id=test_id,
            description=_text(test, "description"),
            setup=setup,
            duration=run.attrib.get("duration", "") if run is not None else "",
            assertions=assertions,
        )

    profiles = {}
    for profile in root.findall("./simulation_profiles/profile"):
        profile_id = profile.attrib.get("id", "")
        props = {}
        for p in profile.findall("property"):
            name = p.attrib.get("name")
            if name:
                props[name] = p.attrib.get("value", "")
        profiles[profile_id] = SimulationProfile(
            id=profile_id,
            default=profile.attrib.get("default", "false").lower() == "true",
            backends=[b.attrib.get("type", "") for b in profile.findall("backend")],
            included_subsystems=[i.attrib.get("subsystem", "") for i in profile.findall("include")],
            tests=[r.attrib.get("test", "") for r in profile.findall("run")],
            properties=props,
        )

    exports = [
        ExportTarget(
            target=e.attrib.get("target", ""),
            enabled=e.attrib.get("enabled", "false").lower() == "true",
        )
        for e in root.findall("./exports/export")
    ]

    return SystemIR(
        name=root.attrib.get("name", ""),
        ir_version=root.attrib.get("ir_version", ""),
        metadata=metadata,
        nets=nets,
        power_domains=power_domains,
        components=components,
        interfaces=interfaces,
        analog=analog,
        firmware_projects=firmware_projects,
        firmware_bindings=firmware_bindings,
        firmware_tasks=firmware_tasks,
        bridges=bridges,
        tests=tests,
        simulation_profiles=profiles,
        exports=exports,
    )


def _text(parent: ET.Element | None, tag: str) -> str:
    if parent is None:
        return ""
    child = parent.find(tag)
    return child.text.strip() if child is not None and child.text else ""


def _child_attr(parent: ET.Element, tag: str, attr: str) -> str:
    child = parent.find(tag)
    return child.attrib.get(attr, "") if child is not None else ""
