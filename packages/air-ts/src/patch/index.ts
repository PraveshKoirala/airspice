/**
 * Port of `packages/core/src/air/patches.py` -- the patch engine.
 *
 * Two contracts, kept SEPARATE from the normalizer (issue #11 guardrail: patch
 * and normalize are distinct stages, never a merged "fix XML" blob):
 *   - applyPatchTree(root, patchRoot): structurally apply <replace>/<remove>/
 *     <add> operations against a design tree, returning a NEW tree (the input is
 *     never mutated -- the oracle deepcopies the design root, patches.py:8).
 *   - patchOperations(patchRoot): the structured diff the UI preview renders --
 *     one {op, path, payload} per operation, `payload` being the ET.tostring of
 *     the operation's first element child (+ its tail), byte-exact.
 *
 * Conflict/failure diagnostics: patches.py raises raw `ValueError`s, NOT
 * registered diagnostic codes (the registry reserves the PATCH- namespace but
 * declares no PATCH- codes yet). We mirror that with `PatchError` carrying the
 * EXACT message strings the oracle raises, captured from the live oracle:
 *   - "Patch root must be <patch>"
 *   - "Patch operation <{tag}> is missing path"
 *   - "replace operation requires an element payload"
 *   - "add operation requires an element payload"
 *   - "Unsupported patch operation: {tag}"
 *   - "Patch path not found: {path}"
 *   - "Element.remove(x): element not found"   (removing the root itself)
 * so a caller/parity suite sees the same rejection shape as Python.
 */

import type { XmlElement, XmlNode } from "../xml.js";
import { childElements } from "../xml.js";
import { cloneElement } from "../normalizer.js";
import { nodeToStringWithTail } from "./serialize.js";
import { findFirst } from "./path.js";

/** A patch failure. Mirrors the oracle's `ValueError` (patches.py). */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/** One entry of the structured diff (mirrors patch_operations' dicts). */
export interface PatchOperation {
  op: string;
  path: string;
  payload: string;
}

/**
 * Apply a patch tree to a design root, returning a NEW root (the input `root` is
 * cloned first, exactly like `deepcopy(tree.getroot())`).
 *
 * PARITY (patches.py:7-39): iterate the patch root's element children; skip
 * <reason>; every other op needs a `path` attribute. <replace> clears the target
 * and adopts the payload's tag/attrib/text/children; <remove> unlinks the target
 * from its parent; <add> appends a deep copy of the payload to the target parent.
 */
export function applyPatchTree(
  root: XmlElement,
  patchRoot: XmlElement,
): XmlElement {
  const out = cloneElement(root);
  if (patchRoot.tag !== "patch") {
    throw new PatchError("Patch root must be <patch>");
  }
  for (const operation of childElements(patchRoot)) {
    if (operation.tag === "reason") continue;
    const path = operation.attrib.get("path");
    // PARITY: `if not path` -- treats a missing OR empty path as missing.
    if (!path) {
      throw new PatchError(
        `Patch operation <${operation.tag}> is missing path`,
      );
    }
    if (operation.tag === "replace") {
      const target = findRequired(out, path);
      const replacement = firstElementChild(operation);
      if (replacement === null) {
        throw new PatchError("replace operation requires an element payload");
      }
      // target.clear(); target.tag/attrib/text/children := replacement's.
      // ElementTree `clear()` also drops the target's tail, but tail lives on
      // the PARENT's child list in our model (it is a following text run), so we
      // leave surrounding text runs untouched and only rewrite the element node.
      target.tag = replacement.tag;
      target.attrib = new Map(replacement.attrib);
      target.children = deepCopyChildren(replacement.children);
    } else if (operation.tag === "remove") {
      const [parent, target] = findParentRequired(out, path);
      removeChild(parent, target, path);
    } else if (operation.tag === "add") {
      const parent = findRequired(out, path);
      const payload = firstElementChild(operation);
      if (payload === null) {
        throw new PatchError("add operation requires an element payload");
      }
      parent.children.push(cloneElement(payload));
    } else {
      throw new PatchError(`Unsupported patch operation: ${operation.tag}`);
    }
  }
  return out;
}

/**
 * The structured diff (mirrors patch_operations, patches.py:42-57): one entry
 * per non-<reason> operation. `payload` is the ET.tostring of the op's first
 * element child WITH its tail, or "" when there is none.
 */
export function patchOperations(patchRoot: XmlElement): PatchOperation[] {
  if (patchRoot.tag !== "patch") {
    throw new PatchError("Patch root must be <patch>");
  }
  const operations: PatchOperation[] = [];
  for (const operation of childElements(patchRoot)) {
    if (operation.tag === "reason") continue;
    const child = firstElementChild(operation);
    operations.push({
      op: operation.tag,
      path: operation.attrib.get("path") ?? "",
      payload:
        child !== null
          ? nodeToStringWithTail(child, tailOf(operation, child))
          : "",
    });
  }
  return operations;
}

// --- helpers mirroring the private patches.py functions --------------------- #

/** patches.py `_find_required`: find(normalize(path)) or raise not-found. */
function findRequired(root: XmlElement, path: string): XmlElement {
  const normalized = normalizePath(path);
  const found = findFirst(root, normalized);
  if (found === null) {
    throw new PatchError(`Patch path not found: ${path}`);
  }
  return found;
}

/**
 * patches.py `_find_parent_required`: resolve the parent by stripping the last
 * `/`-segment of the NORMALIZED path (falling back to `.`), and the target by
 * the full normalized path. Raise not-found if either is missing.
 *
 * PARITY -- DOCUMENTED DIVERGENCE (PR #87 rework r1, F2): like the oracle's
 * `rsplit("/", 1)`, the split below is quote-blind, so a `/` INSIDE a predicate
 * value (e.g. remove path="nets/net[@id='a/b']") mangles the parent path to
 * `nets/net[@id='a`. From that same mangled input the two engines part ways:
 * CPython's ElementPath compiler CRASHES INTERNALLY on the unterminated
 * predicate (`TypeError: 'NoneType' object is not callable` out of
 * xml.etree.ElementPath), while our tokenizer treats the unterminated bracket
 * as predicate-less, resolves some parent, and the remove fails cleanly with
 * PatchError("Element.remove(x): element not found"). BOTH engines reject the
 * patch -- no wrong output escapes -- but the error TYPE and MESSAGE differ on
 * this input. Mimicking an interpreter-internal TypeError message is
 * deliberately NOT attempted; the divergence is pinned by the
 * `slash_predicate.err_slash` fixture (oracle side recorded by
 * gen-patch-refs.py) and probe 8 in patch_probes.test.ts.
 */
function findParentRequired(
  root: XmlElement,
  path: string,
): [XmlElement, XmlElement] {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  const parentPath = idx === -1 ? "." : normalized.slice(0, idx);
  const parent = findFirst(root, parentPath);
  const target = findFirst(root, normalized);
  if (parent === null || target === null) {
    throw new PatchError(`Patch path not found: ${path}`);
  }
  return [parent, target];
}

/**
 * patches.py `_normalize_path`: `/system/...` -> `./...`, `/system` -> `.`,
 * everything else unchanged.
 */
function normalizePath(path: string): string {
  const PREFIX = "/system/";
  if (path.startsWith(PREFIX)) {
    return "./" + path.slice(PREFIX.length);
  }
  if (path === "/system") {
    return ".";
  }
  return path;
}

/** patches.py `_first_element_child`: the first ELEMENT child, or null. */
function firstElementChild(element: XmlElement): XmlElement | null {
  for (const child of element.children) {
    if (child.kind === "element") return child;
  }
  return null;
}

/**
 * The `.tail` of `child` inside `parent`: the concatenation of the text run(s)
 * that immediately follow `child` in the parent's children list, up to the next
 * element (ElementTree stores everything between a child's close tag and the
 * next sibling element in that child's `.tail`). Used only by patchOperations to
 * reproduce ET.tostring's tail inclusion.
 */
function tailOf(parent: XmlElement, child: XmlElement): string {
  const idx = parent.children.indexOf(child);
  if (idx === -1) return "";
  let tail = "";
  for (let i = idx + 1; i < parent.children.length; i++) {
    const node = parent.children[i]!;
    if (node.kind === "text") tail += node.value;
    else break;
  }
  return tail;
}

/**
 * `parent.remove(target)` (ElementTree): unlink `target` from `parent.children`.
 * If `target` is not actually a child (e.g. removing the root itself, where the
 * parent resolves to the same node), ElementTree raises
 * "Element.remove(x): element not found" -- we mirror that message exactly.
 */
function removeChild(
  parent: XmlElement,
  target: XmlElement,
  _path: string,
): void {
  const idx = parent.children.indexOf(target);
  if (idx === -1) {
    throw new PatchError("Element.remove(x): element not found");
  }
  parent.children.splice(idx, 1);
}

/** Deep copy a list of nodes (elements + text), mirroring list(deepcopy(el)). */
function deepCopyChildren(nodes: XmlNode[]): XmlNode[] {
  return nodes.map((n) =>
    n.kind === "element" ? cloneElement(n) : { kind: "text", value: n.value },
  );
}
