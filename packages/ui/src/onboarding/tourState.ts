/**
 * First-run tour flag (issue #28 deliverable 4).
 *
 * The tour appears EXACTLY ONCE per fresh profile and never auto-repeats. The
 * "have they seen it" bit is a single localStorage flag — so it survives reloads
 * and new tabs but resets for a genuinely fresh profile (cleared storage). The
 * logic here is intentionally a tiny, dependency-free, side-effect-only-on-
 * localStorage module so it is trivially unit-testable:
 *
 *   hasSeenTour()  -> should the tour be suppressed? (flag is set)
 *   markTourSeen() -> record that it has been shown (set the flag)
 *   resetTour()    -> re-arm it (clear the flag) — the Help "replay" affordance
 *
 * `markTourSeen` is called when the user finishes OR dismisses the tour, so a
 * dismiss counts the same as a completion: it will not come back on the next
 * load. Re-launching from Help calls `resetTour()` first, so an explicit replay
 * always shows even for a returning user.
 */

export const TOUR_SEEN_KEY = "airspice.onboarding.tourSeen.v1";

function storage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Access can throw in sandboxed iframes / private mode; treat as unavailable.
  }
  return null;
}

/** True once the tour has been shown (and should be suppressed on load). */
export function hasSeenTour(): boolean {
  return storage()?.getItem(TOUR_SEEN_KEY) === "1";
}

/** True on a fresh profile — the tour should auto-show now. */
export function shouldAutoShowTour(): boolean {
  return !hasSeenTour();
}

/** Record that the tour has been shown; it will not auto-appear again. */
export function markTourSeen(): void {
  storage()?.setItem(TOUR_SEEN_KEY, "1");
}

/** Re-arm the tour (the Help "replay" affordance). */
export function resetTour(): void {
  storage()?.removeItem(TOUR_SEEN_KEY);
}
