from __future__ import annotations

from copy import deepcopy
from xml.etree import ElementTree as ET


def apply_patch_tree(tree: ET.ElementTree, patch_tree: ET.ElementTree) -> ET.ElementTree:
    root = deepcopy(tree.getroot())
    patch_root = patch_tree.getroot()
    if patch_root.tag != "patch":
        raise ValueError("Patch root must be <patch>")
    for operation in patch_root:
        if operation.tag == "reason":
            continue
        path = operation.attrib.get("path")
        if not path:
            raise ValueError(f"Patch operation <{operation.tag}> is missing path")
        if operation.tag == "replace":
            target = _find_required(root, path)
            replacement = _first_element_child(operation)
            if replacement is None:
                raise ValueError("replace operation requires an element payload")
            target.clear()
            target.tag = replacement.tag
            target.attrib.update(replacement.attrib)
            target.text = replacement.text
            target[:] = list(deepcopy(replacement))
        elif operation.tag == "remove":
            parent, target = _find_parent_required(root, path)
            parent.remove(target)
        elif operation.tag == "add":
            parent = _find_required(root, path)
            payload = _first_element_child(operation)
            if payload is None:
                raise ValueError("add operation requires an element payload")
            parent.append(deepcopy(payload))
        else:
            raise ValueError(f"Unsupported patch operation: {operation.tag}")
    return ET.ElementTree(root)


def patch_operations(patch_tree: ET.ElementTree) -> list[dict[str, str]]:
    patch_root = patch_tree.getroot()
    if patch_root.tag != "patch":
        raise ValueError("Patch root must be <patch>")
    operations = []
    for operation in patch_root:
        if operation.tag == "reason":
            continue
        operations.append(
            {
                "op": operation.tag,
                "path": operation.attrib.get("path", ""),
                "payload": ET.tostring(_first_element_child(operation), encoding="unicode") if _first_element_child(operation) is not None else "",
            }
        )
    return operations


def _find_required(root: ET.Element, path: str) -> ET.Element:
    normalized = _normalize_path(path)
    found = root.find(normalized)
    if found is None:
        raise ValueError(f"Patch path not found: {path}")
    return found


def _find_parent_required(root: ET.Element, path: str) -> tuple[ET.Element, ET.Element]:
    normalized = _normalize_path(path)
    parts = normalized.rsplit("/", 1)
    parent_path = parts[0] if len(parts) == 2 else "."
    parent = root.find(parent_path)
    target = root.find(normalized)
    if parent is None or target is None:
        raise ValueError(f"Patch path not found: {path}")
    return parent, target


def _normalize_path(path: str) -> str:
    if path.startswith("/system/"):
        return "./" + path[len("/system/") :]
    if path == "/system":
        return "."
    return path


def _first_element_child(element: ET.Element) -> ET.Element | None:
    for child in element:
        return child
    return None
