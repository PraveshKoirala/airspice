/**
 * Undo/redo history for schematic + editor edits (issue #24 D5 / issue #126).
 *
 * DESIGN NOTE - INVERSE PATCHES FOR HISTORIC UNDO/REDO
 *
 * In accordance with the issue #24 guardrail and issue #126, the history stack
 * stores XML PATCH documents (undoPatch and redoPatch) representing the inverse
 * and forward edits, rather than full-document string snapshots.
 *
 *   1) MINIMAL element-scoped patches (issue #126). `pushHistoryEntry` diffs the
 *      canonical `before`/`after` documents STRUCTURALLY (see buildMinimalPatches):
 *      it walks the top-level sections and, inside the id-keyed containers
 *      (`components`, `nets`), matches children by id. A single-element edit
 *      (Inspector attr/id, drag/nudge, wire, palette place, delete) therefore
 *      records a `redoPatch` that <replace>/<add>/<remove>s just the changed
 *      element and an `undoPatch` that is its exact INVERSE -- built with the
 *      air-ts patch engine (applyPatch + the <patch>/<replace>/<add>/<remove>
 *      shape). A one-attribute edit on a 120-component design records ~1% of the
 *      whole-document size (measured), not a full-document snapshot.
 *
 *   2) Byte-Exactness is NON-NEGOTIABLE and is GUARANTEED BY CONSTRUCTION, not by
 *      trust: a minimal pair is adopted ONLY after it is round-trip-VERIFIED --
 *      `applyPatch(before, redoPatch) === after` AND
 *      `applyPatch(after, undoPatch) === before` (byte-for-byte, both directions).
 *      Because `applyPatch` re-canonicalizes, this reproduces the SAME bytes the
 *      root-replace fallback would restore (`canonicalize(after)`/`(before)`), so
 *      the 5-source undo/redo byte-exactness is preserved exactly.
 *
 *   3) FALLBACK: `buildReplaceRootPatch` (a whole-root replace) is used when a
 *      minimal inverse cannot be computed or verified -- arbitrary/unstructured
 *      text edits (Monaco typing), agent multi-section rewrites, or any diff that
 *      fails verification or is not smaller than the root replace. This is the
 *      SAME representation the history used before #126, so those cases are
 *      byte-for-byte identical to the prior behavior; only single-element edits
 *      change (they now cost ~the changed element instead of the whole document).
 *
 * ------------------------------------------------------------------
 *
 * Cross-source coverage (issue #24 acceptance).
 *
 * The store is driven by ONE call site: `pushHistoryEntry(before, after,
 * source)`. Every mutation in the app goes through it:
 *
 *   - Inspector edits (#22 D)           -> commitPatch (schematic/gate.ts)
 *   - Drag/nudge (#23)                  -> App.commitMove -> commitPatch
 *   - Wiring (this issue)               -> commitPatch
 *   - Palette-place, component-delete   -> commitPatch
 *   - Agent apply (#18)                 -> applyValidated wrapper (see
 *                                          designStore listener below)
 *   - Raw XML typing in Monaco          -> setUserXml with coalescing
 *                                          (idle-pause groups keystrokes into
 *                                          ONE history entry -- see
 *                                          coalesceUserXml)
 *
 * Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) are wired at the app level in App.tsx.
 *
 * Redo stack is cleared on any new push (the standard editor semantics).
 */

import { create } from "zustand";
import { useDesignStore } from "../agent/designStore";
import { applyPatch, parseXml } from "air-ts";

/** Cap on undo depth. Issue #24 requires >= 100. */
export const HISTORY_LIMIT = 200;

/**
 * Idle-pause window for Monaco/text-edit coalescing. Rapid keystrokes inside
 * this window fold into ONE history entry (per acceptance criterion "text
 * edits enter as ONE coalesced step per idle-pause"). 500 ms matches the
 * user's expected typing rhythm; anything shorter fragments too much,
 * anything longer feels "sticky" on manual undo.
 */
export const COALESCE_IDLE_MS = 500;

export type HistorySource =
  | "inspector"
  | "drag"
  | "wire"
  | "palette"
  | "delete"
  | "agent"
  | "typing"
  | "external";

export interface HistoryEntry {
  undoPatch: string;
  redoPatch: string;
  source: HistorySource;
  /** Human-readable label for status/tooltips (not stable, don't persist). */
  label: string;
  /** ms epoch. Purely for typing-coalesce decisions. */
  timestamp: number;
}

export interface HistoryState {
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /**
   * When true, the next setUserXml call is a REPLAY from undo/redo -- do not
   * push a new history entry for it. This mirrors the classic "muted" flag
   * pattern used by every editor: undo dispatches a write, the write updates
   * state, and the write listener must not recurse.
   */
  suppressCapture: boolean;
  /**
   * When true, the next setUserXml call is a commitPatch-owned write and
   * the external-writer listener (in App.tsx) MUST NOT capture it -- the
   * commitPatch will push its own entry immediately after setUserXml
   * returns. Distinct from `suppressCapture` so undo/redo replays remain
   * blockable independently.
   */
  internalWrite: boolean;
  push: (entry: HistoryEntry) => void;
  undo: () => HistoryEntry | null;
  redo: () => HistoryEntry | null;
  clear: () => void;
  setSuppress: (v: boolean) => void;
  setInternalWrite: (v: boolean) => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  undoStack: [],
  redoStack: [],
  suppressCapture: false,
  internalWrite: false,
  setInternalWrite: (v) => set({ internalWrite: v }),
  push: (entry) => {
    const s = get();
    if (s.suppressCapture) return; // replay: don't record
    const nextUndo = [...s.undoStack, entry];
    if (nextUndo.length > HISTORY_LIMIT) nextUndo.shift();
    set({ undoStack: nextUndo, redoStack: [] });
  },
  undo: () => {
    const s = get();
    const top = s.undoStack[s.undoStack.length - 1];
    if (!top) return null;
    set({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, top],
    });
    return top;
  },
  redo: () => {
    const s = get();
    const top = s.redoStack[s.redoStack.length - 1];
    if (!top) return null;
    set({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, top],
    });
    return top;
  },
  clear: () => set({ undoStack: [], redoStack: [] }),
  setSuppress: (v) => set({ suppressCapture: v }),
}));

/** Non-reactive snapshot (mirrors designStore/interaction patterns). */
export function historySnapshot(): { undoDepth: number; redoDepth: number } {
  const s = useHistoryStore.getState();
  return { undoDepth: s.undoStack.length, redoDepth: s.redoStack.length };
}

function buildReplaceRootPatch(xml: string): string {
  const cleanXml = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  return `<patch><replace path=".">${cleanXml}</replace></patch>`;
}

// ------------------------------------------------------------------
// Minimal changed-element inverse patches (issue #126)
// ------------------------------------------------------------------
//
// The primitives below diff two CANONICAL design documents and emit the
// smallest `<patch>` that transforms one into the other (plus its inverse),
// scoped to the elements that actually changed. They are intentionally simple:
// every candidate they produce is byte-exact-VERIFIED by pushHistoryEntry before
// it is adopted (and falls back to the whole-root replace otherwise), so the
// diff only has to be CORRECT for the common single-element cases -- it never
// has to be trusted for byte-exactness.

/** The element node type air-ts's `parseXml` yields (not re-exported by name). */
type El = ReturnType<typeof parseXml>;

/** Direct ELEMENT children (text/indentation runs skipped). */
function elementChildren(el: El): El[] {
  return el.children.filter((c): c is El => c.kind === "element");
}

function escAttrValue(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escTextValue(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Deterministic XML serialization of an element, used BOTH as a `<patch>`
 * payload AND as the structural-equality key. Attributes are emitted in sorted
 * order and pure-whitespace (indentation) text runs are dropped -- the patch
 * engine re-canonicalizes any payload we hand it, so only tag / attributes /
 * child structure / leaf text must survive the round trip. Two structurally
 * identical elements (both drawn from canonical documents) therefore serialize
 * to identical strings.
 */
function serializeEl(el: El): string {
  const attrs = [...el.attrib.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => ` ${k}="${escAttrValue(v)}"`)
    .join("");
  const kids = elementChildren(el);
  if (kids.length > 0) {
    return `<${el.tag}${attrs}>${kids.map(serializeEl).join("")}</${el.tag}>`;
  }
  let text = "";
  for (const c of el.children) if (c.kind === "text") text += c.value;
  if (text.trim() === "") return `<${el.tag}${attrs}/>`;
  return `<${el.tag}${attrs}>${escTextValue(text)}</${el.tag}>`;
}

interface OpPair {
  redoOps: string[];
  undoOps: string[];
}

/**
 * Diff an id-keyed container section (e.g. `<components>`, `<nets>`) by matching
 * children on (tag, id). Returns `null` when the section is NOT purely id-keyed
 * (any child lacks an id, or an id repeats) so the caller can fall back to a
 * whole-section replace. Each differing child becomes ONE op: a changed child is
 * a `<replace>`, an added child a `<add>`, a removed child a `<remove>` -- with
 * the exact inverse recorded on the undo side.
 */
function diffKeyedSection(
  sectionTag: string,
  before: El,
  after: El,
): OpPair | null {
  const keyOf = (el: El): string | null => {
    const id = el.attrib.get("id");
    return id === undefined ? null : `${el.tag}\u0000${id}`;
  };
  const toMap = (kids: El[]): Map<string, El> | null => {
    const m = new Map<string, El>();
    for (const c of kids) {
      const k = keyOf(c);
      if (k === null || m.has(k)) return null;
      m.set(k, c);
    }
    return m;
  };
  const bMap = toMap(elementChildren(before));
  const aMap = toMap(elementChildren(after));
  if (bMap === null || aMap === null) return null;

  const redoOps: string[] = [];
  const undoOps: string[] = [];
  const keys = new Set<string>([...bMap.keys(), ...aMap.keys()]);
  for (const k of keys) {
    const b = bMap.get(k);
    const a = aMap.get(k);
    if (b && a) {
      if (serializeEl(b) === serializeEl(a)) continue;
      const path = `${sectionTag}/${a.tag}[@id='${a.attrib.get("id")}']`;
      redoOps.push(`<replace path="${path}">${serializeEl(a)}</replace>`);
      undoOps.push(`<replace path="${path}">${serializeEl(b)}</replace>`);
    } else if (a && !b) {
      const path = `${sectionTag}/${a.tag}[@id='${a.attrib.get("id")}']`;
      redoOps.push(`<add path="${sectionTag}">${serializeEl(a)}</add>`);
      undoOps.push(`<remove path="${path}"/>`);
    } else if (b && !a) {
      const path = `${sectionTag}/${b.tag}[@id='${b.attrib.get("id")}']`;
      redoOps.push(`<remove path="${path}"/>`);
      undoOps.push(`<add path="${sectionTag}">${serializeEl(b)}</add>`);
    }
  }
  return { redoOps, undoOps };
}

/**
 * Build a minimal (redoPatch, undoPatch) pair from two canonical documents, or
 * `null` when no structural diff is expressible (the caller then falls back to
 * the whole-root replace). Sections are unique-by-tag in AIR; a changed id-keyed
 * section is diffed per-child, any other changed section is replaced whole.
 *
 * The result is a CANDIDATE only -- pushHistoryEntry round-trip-verifies it for
 * byte-exactness before adopting it.
 */
function buildMinimalPatches(
  before: string,
  after: string,
): { redoPatch: string; undoPatch: string } | null {
  let beforeRoot: El;
  let afterRoot: El;
  try {
    beforeRoot = parseXml(before);
    afterRoot = parseXml(after);
  } catch {
    return null;
  }
  if (beforeRoot.tag !== afterRoot.tag) return null;

  const byTag = (secs: El[]): Map<string, El> | null => {
    const m = new Map<string, El>();
    for (const s of secs) {
      if (m.has(s.tag)) return null; // duplicate section tags: bail to fallback
      m.set(s.tag, s);
    }
    return m;
  };
  const bByTag = byTag(elementChildren(beforeRoot));
  const aByTag = byTag(elementChildren(afterRoot));
  if (bByTag === null || aByTag === null) return null;

  const redoOps: string[] = [];
  const undoOps: string[] = [];
  const tags = new Set<string>([...bByTag.keys(), ...aByTag.keys()]);
  for (const tag of tags) {
    const b = bByTag.get(tag);
    const a = aByTag.get(tag);
    if (b && a) {
      if (serializeEl(b) === serializeEl(a)) continue; // section unchanged
      const keyed = diffKeyedSection(tag, b, a);
      if (keyed === null) {
        // Not an id-keyed container: replace the whole section (still far
        // smaller than the whole document when only one section changed).
        redoOps.push(`<replace path="${tag}">${serializeEl(a)}</replace>`);
        undoOps.push(`<replace path="${tag}">${serializeEl(b)}</replace>`);
      } else {
        redoOps.push(...keyed.redoOps);
        undoOps.push(...keyed.undoOps);
      }
    } else if (a && !b) {
      redoOps.push(`<add path=".">${serializeEl(a)}</add>`);
      undoOps.push(`<remove path="${tag}"/>`);
    } else if (b && !a) {
      redoOps.push(`<remove path="${tag}"/>`);
      undoOps.push(`<add path=".">${serializeEl(b)}</add>`);
    }
  }
  if (redoOps.length === 0) return null; // before !== after but no element diff
  return {
    redoPatch: `<patch>${redoOps.join("")}</patch>`,
    undoPatch: `<patch>${undoOps.join("")}</patch>`,
  };
}

/**
 * Compute a minimal, byte-exact-verified (redoPatch, undoPatch) pair for the
 * `before -> after` transition, or `null` to signal the whole-root fallback.
 *
 * A candidate is adopted ONLY when it BOTH round-trips byte-for-byte in BOTH
 * directions AND is strictly smaller than the whole-root replace it would
 * replace. The verification targets the raw `before`/`after` strings: since
 * `applyPatch` always re-canonicalizes, a candidate can only match when those
 * strings are already canonical, in which case the restored bytes are identical
 * to what the root-replace fallback (`canonicalize(after)`/`(before)`) yields --
 * so undo/redo byte-exactness is preserved in every case.
 */
function minimalPatchPair(
  before: string,
  after: string,
): { redoPatch: string; undoPatch: string } | null {
  const candidate = buildMinimalPatches(before, after);
  if (candidate === null) return null;
  try {
    if (applyPatch(before, candidate.redoPatch) !== after) return null;
    if (applyPatch(after, candidate.undoPatch) !== before) return null;
  } catch {
    return null;
  }
  const fallbackLen =
    buildReplaceRootPatch(before).length + buildReplaceRootPatch(after).length;
  const candidateLen = candidate.redoPatch.length + candidate.undoPatch.length;
  if (candidateLen >= fallbackLen) return null; // never regress memory
  return candidate;
}

/**
 * Push a fresh history entry recording that the design moved from `before`
 * to `after` via `source`. Called by the ONE write path (schematic/gate.ts,
 * plus the Monaco coalescer and the agent listener). Skips no-op writes.
 *
 * For a single-element edit this records MINIMAL changed-element patches
 * (issue #126); for anything that can't be minimally + byte-exactly inverted it
 * falls back to the whole-root replace (the pre-#126 representation).
 */
export function pushHistoryEntry(
  before: string,
  after: string,
  source: HistorySource,
  label: string,
): void {
  if (before === after) return;
  const minimal = minimalPatchPair(before, after);
  const undoPatch = minimal ? minimal.undoPatch : buildReplaceRootPatch(before);
  const redoPatch = minimal ? minimal.redoPatch : buildReplaceRootPatch(after);
  useHistoryStore.getState().push({
    undoPatch,
    redoPatch,
    source,
    label,
    timestamp: Date.now(),
  });
}

/**
 * Perform an undo: pop the newest entry, replay `before` through setUserXml
 * WITHOUT re-capturing. Returns the entry (for the status line) or null when
 * the stack is empty.
 */
export function performUndo(): HistoryEntry | null {
  const entry = useHistoryStore.getState().undo();
  if (!entry) return null;
  const s = useHistoryStore.getState();
  s.setSuppress(true);
  try {
    const current = useDesignStore.getState().xml;
    const restored = applyPatch(current, entry.undoPatch);
    useDesignStore.getState().setUserXml(restored);
  } finally {
    s.setSuppress(false);
  }
  return entry;
}

/** Redo: pop the newest redo entry, replay `after`. Returns the entry. */
export function performRedo(): HistoryEntry | null {
  const entry = useHistoryStore.getState().redo();
  if (!entry) return null;
  const s = useHistoryStore.getState();
  s.setSuppress(true);
  try {
    const current = useDesignStore.getState().xml;
    const restored = applyPatch(current, entry.redoPatch);
    useDesignStore.getState().setUserXml(restored);
  } finally {
    s.setSuppress(false);
  }
  return entry;
}

/**
 * Text-edit coalescing (Monaco / raw XML typing). Rapid keystrokes are
 * folded into ONE history entry per idle-pause. Call this instead of
 * setUserXml + pushHistoryEntry from the raw editor's onChange handler.
 *
 * The rule (per issue #24 acceptance criterion): "text edits enter as ONE
 * coalesced step per idle-pause". We hold the FIRST pre-image seen since the
 * last flush, and every setUserXml call reschedules a debounce timer. When
 * the timer fires (COALESCE_IDLE_MS after the last keystroke), we push ONE
 * entry from that held pre-image to the current XML. If undo is invoked
 * mid-coalesce, we flush first so the pending keystrokes are captured.
 */
let coalescePreImage: string | null = null;
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

export function coalesceUserXml(next: string): void {
  const s = useDesignStore.getState();
  const current = s.xml;
  if (next === current) return;
  if (coalescePreImage === null) coalescePreImage = current;
  // Set internalWrite so the external-writer listener doesn't record
  // each keystroke as its own history entry. The coalesced entry is
  // pushed by flushCoalescedEdit below (on the idle-pause timer or on
  // the next non-typing edit / undo).
  const hs = useHistoryStore.getState();
  hs.setInternalWrite(true);
  try {
    s.setUserXml(next); // bump version now so live schematic/validation refresh
  } finally {
    hs.setInternalWrite(false);
  }
  if (coalesceTimer !== null) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(() => {
    flushCoalescedEdit();
  }, COALESCE_IDLE_MS);
}

/**
 * Force the pending coalesced edit (if any) into a history entry. Called on
 * every non-typing edit (inspector/drag/palette/wire), and before undo/redo
 * so a mid-type undo behaves as the user would expect.
 */
export function flushCoalescedEdit(): void {
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  const pre = coalescePreImage;
  coalescePreImage = null;
  if (pre === null) return;
  const after = useDesignStore.getState().xml;
  if (pre === after) return;
  pushHistoryEntry(pre, after, "typing", "typing");
}

/**
 * Reset the history stacks (called on hard resets like loading a new
 * design). Also drops any pending coalesced pre-image.
 */
export function resetHistory(): void {
  coalescePreImage = null;
  if (coalesceTimer !== null) {
    clearTimeout(coalesceTimer);
    coalesceTimer = null;
  }
  useHistoryStore.getState().clear();
}
