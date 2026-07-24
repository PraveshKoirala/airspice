/**
 * Workspace entry intent (issue #28 deliverable 3).
 *
 * The Landing page and the workspace are separate routes. When a "Fix me" card is
 * clicked we want the workspace to open ON the Repair tab (primed for the
 * autonomous loop), and when "Take the tour" is clicked we want the tour to show
 * on arrival. Those are one-shot signals handed from Landing to the workspace
 * across an SPA navigation.
 *
 * A tiny module-level singleton is enough (and simpler than a store): Landing
 * sets it right before `navigate('/project')`, the workspace reads-and-clears it
 * once on mount. Being one-shot (cleared on read) is the point — a later plain
 * navigation to the workspace must NOT re-trigger the repair tab or the tour.
 */

export interface WorkspaceIntent {
  /** Tab id to open on arrival (e.g. "repair" for a Fix-me card). */
  tab: string | null;
  /** Force-show the first-run tour on arrival (the Landing "Take the tour"). */
  tour: boolean;
}

let intent: WorkspaceIntent = { tab: null, tour: false };

/** Queue an intent for the next workspace mount (Landing calls this). */
export function setWorkspaceIntent(next: Partial<WorkspaceIntent>): void {
  intent = { ...intent, ...next };
}

/** Read the pending intent and clear it (one-shot; the workspace calls this). */
export function takeWorkspaceIntent(): WorkspaceIntent {
  const current = intent;
  intent = { tab: null, tour: false };
  return current;
}
