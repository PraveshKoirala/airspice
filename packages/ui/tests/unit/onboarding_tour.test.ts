/**
 * Issue #28 — first-run tour flag logic (unit).
 *
 * Encodes the PRD bar: the tour "appears exactly once per fresh profile
 * (localStorage flag), never auto-repeats, and is re-launchable from a Help
 * affordance."
 *
 * ── Stated assumption (the builder matches this pure-logic module) ──
 *  The tour's persistence lives in `packages/ui/src/onboarding/tourState.ts`,
 *  a DOM-free module backed by localStorage, exporting:
 *    • shouldShowTour(): boolean   — true only for a fresh profile
 *    • markTourSeen(): void        — dismiss; persists the seen flag
 *    • rearmTour(): void           — Help re-launch; clears the flag
 *    • TOUR_STORAGE_KEY: string    — the localStorage key it uses
 *  Functions read localStorage at CALL time (not import time).
 *
 * How this kills a stub: a tour that repeats every load (shouldShowTour always
 * true) fails "suppressed after dismiss"; a tour with no re-arm fails the Help
 * case; a hardcoded `return true/false` fails one of the three transitions.
 */

import { beforeEach, describe, expect, it } from "vitest";

/** Minimal in-memory Storage so the DOM-free module runs under vitest's node env. */
function installFakeLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const ls = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
  (globalThis as Record<string, unknown>).localStorage = ls;
  return store;
}

type TourModule = typeof import("../../src/onboarding/tourState");

let tour: TourModule;
let store: Map<string, string>;

beforeEach(async () => {
  store = installFakeLocalStorage();
  // Import AFTER the storage shim is installed so a module that touches
  // localStorage during evaluation still loads cleanly.
  tour = await import("../../src/onboarding/tourState");
});

describe("first-run tour flag logic", () => {
  it("exposes a non-empty storage key", () => {
    expect(typeof tour.TOUR_STORAGE_KEY).toBe("string");
    expect(tour.TOUR_STORAGE_KEY.length).toBeGreaterThan(0);
  });

  it("SHOWS once for a fresh profile", () => {
    expect(tour.shouldShowTour()).toBe(true);
  });

  it("is SUPPRESSED after dismiss, and stays suppressed across reloads", () => {
    tour.markTourSeen();
    expect(tour.shouldShowTour()).toBe(false);
    // A persisted flag must back the suppression (simulates surviving a reload).
    expect(store.get(tour.TOUR_STORAGE_KEY)).toBeDefined();
    // Idempotent: querying again does not re-arm it.
    expect(tour.shouldShowTour()).toBe(false);
  });

  it("is RE-ARMABLE from Help (shows again after rearm)", () => {
    tour.markTourSeen();
    expect(tour.shouldShowTour()).toBe(false);

    tour.rearmTour();
    expect(tour.shouldShowTour()).toBe(true);
    // The flag is cleared, not merely toggled in memory.
    expect(store.get(tour.TOUR_STORAGE_KEY)).toBeUndefined();
  });

  it("full lifecycle: fresh → dismiss → reload(suppressed) → help(shown)", () => {
    expect(tour.shouldShowTour()).toBe(true); // fresh
    tour.markTourSeen(); // dismiss
    expect(tour.shouldShowTour()).toBe(false); // reload: still suppressed
    tour.rearmTour(); // Help
    expect(tour.shouldShowTour()).toBe(true); // shown again
  });
});
