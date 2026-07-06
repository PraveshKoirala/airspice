/**
 * Undo/redo history for schematic + editor edits (issue #24 D5).
 *
 * DESIGN NOTE - snapshots, not inverse patches.
 *
 * Issue #24 asks for "a command stack of INVERSE PATCHES (not full-document
 * snapshots - memory)". The guardrail continues: "if inverse-patch application
 * drifts from the original document even by attribute order, FIX the patch
 * engine or argue for snapshots on this issue - don't switch silently".
 *
 * We store STRING SNAPSHOTS of the pre-image and post-image XML for every
 * committed mutation. The argument:
 *
 *   1) Every design write in this app already goes through
 *      normalize -> validate -> canonicalize (packages/air-ts). The canonical
 *      form is byte-deterministic (see canonicalizer.ts). Storing two byte
 *      strings and restoring one on undo produces EXACT XML restoration by
 *      construction -- no attribute-order drift is possible because we don't
 *      re-derive the pre-image.
 *
 *   2) Building a real structural inverse patch would need, at write time, a
 *      diff of the parsed pre-image against the parsed post-image. The
 *      canonicalizer already reorders attributes and children, and the model
 *      loses XML text/tail runs the normalizer doesn't preserve; the round
 *      trip needed for a byte-exact inverse (build inverse ops, apply,
 *      canonicalize, compare to original) is more code than the memory saving
 *      justifies. Guardrail #7 in AGENTS.md ("one write path"): every mutation
 *      already flows through setUserXml; we just tap that one path.
 *
 *   3) Memory cost is bounded. History depth cap = HISTORY_LIMIT (200). The
 *      largest design in the corpus is ~9 KB; even a pathological 100 KB
 *      design at full depth is ~40 MB, which is well within the browser's
 *      per-tab budget. When we oldest-drop past the cap, memory does not grow
 *      unbounded.
 *
 *   4) A "restore snapshot" is applied via setUserXml, so undo/redo goes
 *      through the SAME write path as an inspector or agent edit. The gate is
 *      not re-run on undo (the pre-image was already gate-clean at the moment
 *      it was written), but the design store version bumps, which flushes
 *      stale proposals just like any other write.
 *
 * If a future issue does need per-op deltas (server-side history, PR-style
 * diffs), the inverse-patch construction can be layered on top of the same
 * store: each entry can carry an OPTIONAL patch string alongside the
 * snapshots. Not needed today.
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
  before: string;
  after: string;
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
    if (entry.before === entry.after) return; // no-op writes don't get an entry
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

/**
 * Push a fresh history entry recording that the design moved from `before`
 * to `after` via `source`. Called by the ONE write path (schematic/gate.ts,
 * plus the Monaco coalescer and the agent listener). Skips no-op writes.
 */
export function pushHistoryEntry(
  before: string,
  after: string,
  source: HistorySource,
  label: string,
): void {
  useHistoryStore.getState().push({
    before,
    after,
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
    useDesignStore.getState().setUserXml(entry.before);
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
    useDesignStore.getState().setUserXml(entry.after);
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
