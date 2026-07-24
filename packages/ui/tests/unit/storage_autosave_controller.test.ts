/**
 * AC#1 (unit) — Autosave debounce + flush semantics.
 *
 * The PRD lists "autosave debounce + flush semantics" as a UNIT test. The
 * persistence policy is extracted into a deterministic, DOM-free unit —
 * `createAutosaveController(save, delayMs)` in src/storage/autosave.ts — so it
 * can be proven with fake timers here (the React/`visibilitychange`/`pagehide`
 * wiring that CALLS this controller is exercised separately in the Playwright
 * crash-safety spec).
 *
 * Every assertion is written to FAIL against a naive stub, e.g.:
 *   - save on every schedule()           -> debounce test fails (5 saves, not 1)
 *   - flush() that always calls save()   -> "flush is a no-op when clean" fails
 *   - value captured at schedule time    -> "reads latest value" fails
 *   - cancel() that still fires the timer -> "cancel prevents save" fails
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createAutosaveController } from "../../src/storage/autosave";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AC#1 autosave controller (debounce + flush)", () => {
  it("debounces a burst of schedules into a SINGLE save after the window", () => {
    const save = vi.fn();
    const c = createAutosaveController(save, 1000);

    // Rapid schedules within the window (no time advances between them).
    c.schedule();
    c.schedule();
    c.schedule();
    c.schedule();
    c.schedule();
    expect(save).not.toHaveBeenCalled(); // nothing before the window elapses
    expect(c.pending).toBe(true);

    // Not yet: still inside the debounce window.
    vi.advanceTimersByTime(999);
    expect(save).not.toHaveBeenCalled();

    // Window elapses -> exactly one save.
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(false);

    // A later schedule re-arms and yields a second (single) save.
    c.schedule();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps re-arming the timer so the save fires ~delayMs after the LAST schedule", () => {
    const save = vi.fn();
    const c = createAutosaveController(save, 1000);

    c.schedule();
    vi.advanceTimersByTime(900);
    c.schedule(); // resets the window
    vi.advanceTimersByTime(900); // 1800ms since first, but only 900 since last
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // now 1000ms since the last schedule
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush() persists the pending write IMMEDIATELY and cancels the timer", () => {
    const save = vi.fn();
    const c = createAutosaveController(save, 1000);

    c.schedule();
    expect(save).not.toHaveBeenCalled();

    c.flush(); // immediate, before the debounce window
    expect(save).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(false);

    // The armed timer must have been cancelled — no second save later.
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("flush() is a NO-OP when nothing is pending (no double-write after a debounced save)", () => {
    const save = vi.fn();
    const c = createAutosaveController(save, 1000);

    c.schedule();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1); // debounced save already ran
    expect(c.pending).toBe(false);

    // An unload flush that fires AFTER the debounce already ran must not write.
    c.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // Flush with nothing ever scheduled is also a no-op.
    const save2 = vi.fn();
    const c2 = createAutosaveController(save2, 1000);
    c2.flush();
    expect(save2).not.toHaveBeenCalled();
  });

  it("cancel() drops a pending save without persisting", () => {
    const save = vi.fn();
    const c = createAutosaveController(save, 1000);

    c.schedule();
    expect(c.pending).toBe(true);
    c.cancel();
    expect(c.pending).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(save).not.toHaveBeenCalled(); // the timer was cancelled

    // And a flush after cancel writes nothing (not dirty).
    c.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("runs the save closure against the LATEST value at fire time, not at schedule time", () => {
    let current = "a";
    const persisted: string[] = [];
    const c = createAutosaveController(() => persisted.push(current), 1000);

    // Debounced burst: value changes between schedules.
    c.schedule();
    current = "b";
    c.schedule();
    current = "c";
    c.schedule();

    vi.advanceTimersByTime(1000);
    // Exactly one save, and it captured the value at RUN time ("c"), not "a".
    expect(persisted).toEqual(["c"]);

    // Same for an immediate flush: it must persist the freshest value.
    current = "d";
    c.schedule();
    current = "e";
    c.flush();
    expect(persisted).toEqual(["c", "e"]);
  });
});
