/**
 * Central commit path for schematic edits (issue #24).
 *
 * Every schematic mutation -- inspector edit, drag, wire, palette-place,
 * component-delete -- goes through `commitPatch(patchXml, source, label)`.
 * It performs the SAME three things every write must do:
 *
 *   1) Capture the pre-image XML (from the design store) so history can be
 *      restored byte-exactly (see schematic/history.ts for why snapshots).
 *   2) Run the patch through runGate (previewPatch + applyPatch + normalize
 *      + validate). If the gate rejects, NO write happens and the caller
 *      receives the diagnostic message.
 *   3) On success, flush any pending typing-coalesce, apply the canonical
 *      XML via setUserXml, and push a history entry.
 *
 * This is the ONE WRITE PATH for direct-manipulation schematic edits. The
 * agent write path (applyValidated) also feeds into history via a separate
 * listener wired at app boot (see App.tsx / history subscription).
 *
 * The commit path is intentionally SYNCHRONOUS: the caller (Renderer /
 * Inspector / Palette) needs the ok/error result to decide whether to roll
 * back its transient DOM state.
 */

import { useDesignStore } from "../agent/designStore";
import { runGate, type GateOutcome } from "./patches";
import {
  flushCoalescedEdit,
  pushHistoryEntry,
  useHistoryStore,
  type HistorySource,
} from "./history";

export type CommitResult =
  | { ok: true; xml: string }
  | { ok: false; message: string };

/**
 * Run a patch through the gate and, on success, commit it to the design
 * store AND push a history entry. Uses the CURRENT store XML as the
 * pre-image (so batching several patches from one interaction requires
 * building one <patch> with multiple ops, matching the drag write path).
 */
export function commitPatch(
  patchXml: string,
  source: HistorySource,
  label: string,
): CommitResult {
  const before = useDesignStore.getState().xml;
  const outcome: GateOutcome = runGate(before, patchXml);
  if (!outcome.ok) return { ok: false, message: outcome.message };
  // Flush any pending typing-coalesce so the mutation lands ON TOP of the
  // typed-text history frame (not merged into it).
  flushCoalescedEdit();
  // Set the internalWrite flag around setUserXml so the design store
  // subscription in App.tsx skips this write -- we push the history
  // entry explicitly BELOW. Without this flag the external listener
  // would double-record every direct-manipulation edit.
  const hs = useHistoryStore.getState();
  hs.setInternalWrite(true);
  try {
    useDesignStore.getState().setUserXml(outcome.xml);
  } finally {
    hs.setInternalWrite(false);
  }
  pushHistoryEntry(before, outcome.xml, source, label);
  return { ok: true, xml: outcome.xml };
}
