/**
 * ElementTree `Element.find(path)` for the ElementPath subset the patch engine
 * uses. PARITY: patches.py resolves every op target with `root.find(normalized)`
 * (patches.py:62,72-73) after `_normalize_path` rewrites a leading `/system/`
 * to `./` (or `/system` alone to `.`). The oracle therefore only ever hands
 * ElementTree these shapes:
 *   .                                        (self)
 *   ./a/b/c                                  (descend by child tag)
 *   ./components/component[@id='R_TOP']       (attribute-equality predicate)
 *   ./.../value                               (a final tag step)
 * and, when a patch author writes a raw ElementPath in `path=`, whatever else
 * ElementTree's find accepts. We implement the ElementPath grammar CPython's
 * `xml.etree.ElementPath` supports for a single result (`find` returns the FIRST
 * match): tag steps, `.` and `..`, `*`, the `//` descendant axis (`.//tag`,
 * `a//b`), `[@attr]`, `[@attr='v']`/`[@attr="v"]`, `[tag]` (has-child),
 * `[tag='v']` (child-text equality), and `[n]` (1-based positional).
 * Namespaces are not used in AIR, so `{ns}tag` handling is omitted.
 *
 * `find` returns the first matching element or null (ElementTree returns None),
 * exactly matching the oracle's `if found is None`.
 */

import type { XmlElement } from "../xml.js";
import { childElements, elementText } from "../xml.js";

/**
 * Resolve `path` against `context` like `context.find(path)`. Returns the first
 * matching element, or null. A leading `/` is NOT special here (ElementTree
 * raises on an absolute path); the oracle's `_normalize_path` never produces one
 * -- it rewrites `/system/...` to `./...`. If a raw absolute path reaches here it
 * simply fails to match (returns null), which is the conservative behavior.
 */
export function findFirst(context: XmlElement, path: string): XmlElement | null {
  const steps = tokenizePath(path);
  if (steps === null) return null;
  let current: XmlElement[] = [context];
  let first = true;
  let deep = false;
  for (const step of steps) {
    if (step === "") {
      // An empty segment is a `//` separator (or a leading `/`): the NEXT step
      // searches the descendant axis, matching ElementTree's `.//tag`.
      if (!first) deep = true;
      first = false;
      continue;
    }
    const next: XmlElement[] = [];
    for (const node of current) {
      if (deep) collectStepDeep(node, step, next);
      else collectStep(node, step, next, first);
    }
    current = next;
    first = false;
    deep = false;
    if (current.length === 0) return null;
  }
  return current.length > 0 ? current[0]! : null;
}

/** Split a path into steps, handling predicates that may contain `/` in quotes. */
function tokenizePath(path: string): string[] | null {
  const steps: string[] = [];
  let buf = "";
  let inQuote: string | null = null;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]!;
    if (inQuote) {
      buf += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      buf += ch;
      continue;
    }
    if (ch === "/") {
      steps.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  steps.push(buf);
  return steps;
}

/**
 * Apply one path step to `node`, appending matches to `out`. `isFirst` marks the
 * leading step, where `.` selects the context node itself (ElementTree treats a
 * leading `.` as self).
 */
function collectStep(
  node: XmlElement,
  step: string,
  out: XmlElement[],
  isFirst: boolean,
): void {
  const { tag, predicates } = parseStep(step);

  if (tag === ".") {
    if (matchesAll(node, predicates)) out.push(node);
    return;
  }
  if (tag === "..") {
    // Parent axis is unsupported in our flat model (no parent pointers) and the
    // oracle never emits it; treat as no match.
    return;
  }
  void isFirst;

  // Child-tag (or wildcard) step: scan direct element children.
  let candidates = childElements(node);
  if (tag !== "*") {
    candidates = candidates.filter((c) => c.tag === tag);
  }
  // Split predicates: element-local ones filter each candidate; a positional
  // predicate [n] selects the n-th (1-based) candidate from the set. ElementPath
  // applies the position over the tag-filtered set; the oracle never emits one,
  // so this is only reached by an author-written raw path.
  const local = predicates.filter((p) => p.kind !== "position");
  const positions = predicates.filter(
    (p): p is Extract<Predicate, { kind: "position" }> => p.kind === "position",
  );
  let matched = candidates.filter((c) => matchesAll(c, local));
  for (const pos of positions) {
    const picked = matched[pos.index - 1];
    matched = picked ? [picked] : [];
  }
  for (const cand of matched) out.push(cand);
}

/**
 * Apply one step on the DESCENDANT axis (the step after a `//`): match every
 * element anywhere below `node` (children, grandchildren, ...), in document
 * order, against the step's tag + predicates.
 */
function collectStepDeep(node: XmlElement, step: string, out: XmlElement[]): void {
  const { tag, predicates } = parseStep(step);
  if (tag === "." || tag === "..") return; // not meaningful on this axis
  const local = predicates.filter((p) => p.kind !== "position");
  const positions = predicates.filter(
    (p): p is Extract<Predicate, { kind: "position" }> => p.kind === "position",
  );
  const all: XmlElement[] = [];
  walkDescendants(node, all);
  let matched = all.filter(
    (c) => (tag === "*" || c.tag === tag) && matchesAll(c, local),
  );
  for (const pos of positions) {
    const picked = matched[pos.index - 1];
    matched = picked ? [picked] : [];
  }
  for (const cand of matched) out.push(cand);
}

/** Collect every descendant element of `node` in document order. */
function walkDescendants(node: XmlElement, out: XmlElement[]): void {
  for (const child of childElements(node)) {
    out.push(child);
    walkDescendants(child, out);
  }
}

interface ParsedStep {
  tag: string;
  predicates: Predicate[];
}

type Predicate =
  | { kind: "attr-exists"; name: string }
  | { kind: "attr-eq"; name: string; value: string }
  | { kind: "child-exists"; tag: string }
  | { kind: "child-eq"; tag: string; value: string }
  | { kind: "position"; index: number };

function parseStep(step: string): ParsedStep {
  const bracket = step.indexOf("[");
  if (bracket === -1) {
    return { tag: step, predicates: [] };
  }
  const tag = step.slice(0, bracket);
  const predicates: Predicate[] = [];
  let rest = step.slice(bracket);
  while (rest.startsWith("[")) {
    const close = matchBracket(rest);
    if (close === -1) break;
    const inner = rest.slice(1, close).trim();
    const pred = parsePredicate(inner);
    if (pred) predicates.push(pred);
    rest = rest.slice(close + 1);
  }
  return { tag, predicates };
}

/** Index of the `]` that closes the `[` at position 0, honoring quotes. */
function matchBracket(s: string): number {
  let inQuote: string | null = null;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === "]") return i;
  }
  return -1;
}

function parsePredicate(inner: string): Predicate | null {
  // Positional predicate: [n] (1-based).
  if (/^\d+$/.test(inner)) {
    return { kind: "position", index: parseInt(inner, 10) };
  }
  // Attribute predicates: [@name] or [@name='v'] / [@name="v"].
  if (inner.startsWith("@")) {
    const eq = inner.indexOf("=");
    if (eq === -1) {
      return { kind: "attr-exists", name: inner.slice(1).trim() };
    }
    const name = inner.slice(1, eq).trim();
    const value = unquote(inner.slice(eq + 1).trim());
    return { kind: "attr-eq", name, value };
  }
  // Child predicates: [tag] or [tag='v'] / [tag="v"].
  const eq = inner.indexOf("=");
  if (eq === -1) {
    return { kind: "child-exists", tag: inner.trim() };
  }
  const tag = inner.slice(0, eq).trim();
  const value = unquote(inner.slice(eq + 1).trim());
  return { kind: "child-eq", tag, value };
}

function unquote(s: string): string {
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function matchesAll(el: XmlElement, predicates: Predicate[]): boolean {
  for (const p of predicates) {
    if (!matchesOne(el, p)) return false;
  }
  return true;
}

function matchesOne(el: XmlElement, p: Predicate): boolean {
  switch (p.kind) {
    case "attr-exists":
      return el.attrib.has(p.name);
    case "attr-eq":
      return el.attrib.get(p.name) === p.value;
    case "child-exists":
      return childElements(el).some((c) => c.tag === p.tag);
    case "child-eq": {
      const child = childElements(el).find((c) => c.tag === p.tag);
      return child !== undefined && elementText(child).trim() === p.value;
    }
    case "position":
      // Positional predicates are handled at the step level (collectStep), where
      // the candidate SET is visible; they never reach matchesOne.
      return true;
  }
}
