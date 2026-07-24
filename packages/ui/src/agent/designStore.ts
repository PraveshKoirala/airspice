/**
 * The design store — the UI half of the single-write-path invariant (issue #18).
 *
 * This Zustand store owns the editor's design XML and a MONOTONIC version number
 * (post-audit amendment point 1: the version lives in the store, not the XML).
 * Two mutators touch the design XML, and they are the ONLY writers:
 *
 *   applyValidated(design: ValidatedDesign)
 *       The AGENT write path. It takes a `ValidatedDesign` — a type constructible
 *       SOLELY by the agent layer's gate (`gateDesign`, packages/agent). No
 *       provider output, mock, or test can construct that type, so nothing the
 *       agent produced can reach editor state without having passed
 *       normalize -> validate. This is the invariant, type-enforced end to end.
 *
 *   setUserXml(xml: string)
 *       The HUMAN edit path (Monaco keystrokes / file open). A person typing in
 *       the editor is not "provider output"; the live validation panel already
 *       shows them diagnostics as they type. This path bumps the version too, so
 *       a staged proposal computed against an older version is detected as stale
 *       and Apply re-runs the full gate (amendment point 2). It takes a plain
 *       string BY DESIGN — it is the user, not the agent.
 *
 * Both bump `version`, so every proposal's recorded `baseVersion` can be compared
 * on Apply. There is NO third path that assigns `xml`.
 */

import { create } from "zustand";
import type { ValidatedDesign } from "agent";

export interface DesignState {
  /** The current design XML (the source of truth the editor + engine read). */
  xml: string;
  /** Monotonic version; bumped on every write (agent-apply or user-edit). */
  version: number;

  /**
   * THE AGENT WRITE PATH. Accepts only a gated `ValidatedDesign`. Because that
   * type is unforgeable (packages/agent brand), this signature is the compile-
   * time proof that agent output cannot bypass the gate.
   */
  applyValidated: (design: ValidatedDesign) => void;

  /** THE HUMAN EDIT PATH. A direct user edit (Monaco / open); bumps version. */
  setUserXml: (xml: string) => void;
}

export const useDesignStore = create<DesignState>((set) => ({
  xml: "",
  version: 0,
  applyValidated: (design) =>
    set((s) => ({ xml: design.xml, version: s.version + 1 })),
  setUserXml: (xml) => set((s) => ({ xml, version: s.version + 1 })),
}));

/** Non-reactive snapshot for the tool runtime (reads outside React render). */
export function designSnapshot(): { xml: string; version: number } {
  const { xml, version } = useDesignStore.getState();
  return { xml, version };
}

// Dev/test hook: lets Playwright (and the screenshot harness) load a design
// without driving Monaco. Routes through setUserXml — the human edit path —
// so version bumps and staleness detection behave exactly like a paste.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__airSetXml = (xml: string) =>
    useDesignStore.getState().setUserXml(xml);
  // Inverse getter so the QA harness can capture the exact design the agent
  // produced (for triage) without mounting Monaco.
  (globalThis as Record<string, unknown>).__airGetXml = () =>
    useDesignStore.getState().xml;
}
