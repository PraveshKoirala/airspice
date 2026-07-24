/**
 * Autosave debounce/flush controller (PRD #26 criterion 1).
 *
 * The persistence policy is deliberately extracted OUT of the React component
 * so it is a plain, deterministic unit: edits collapse into a single debounced
 * save (~1s after the last edit), and a `flush()` writes any pending work
 * IMMEDIATELY — the hook a `visibilitychange`→hidden / `pagehide` listener
 * calls so a mid-edit tab close or hard reload cannot lose the last edit.
 *
 * `save` is a caller-supplied closure that reads the LATEST design state at the
 * moment it runs (not captured at schedule time), so a burst of `schedule()`
 * calls always persists the freshest XML, and `flush()` on unload persists
 * whatever is current. The controller owns exactly one pending timer.
 */
export interface AutosaveController {
  /**
   * Debounce a save: cancels any pending timer and arms a fresh one for
   * `delayMs`. Marks the controller dirty so a later `flush()` knows there is
   * un-persisted work.
   */
  schedule(): void;
  /**
   * Persist immediately IF there is pending (un-persisted) work, cancelling the
   * debounce timer. A no-op when nothing is pending (already saved), so an
   * unload flush never issues a redundant write.
   */
  flush(): void;
  /** Drop any pending save without persisting (e.g. on teardown). */
  cancel(): void;
  /** Whether a scheduled save has not yet run/flushed. */
  readonly pending: boolean;
}

/**
 * Create an autosave controller.
 *
 * @param save    Called to persist the current state. Invoked with no args; it
 *                must read the latest state itself.
 * @param delayMs Debounce window in milliseconds (default 1000 ≈ "~1s after the
 *                last edit").
 */
export function createAutosaveController(
  save: () => void,
  delayMs = 1000,
): AutosaveController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const run = () => {
    clear();
    dirty = false;
    save();
  };

  return {
    schedule() {
      dirty = true;
      clear();
      timer = setTimeout(run, delayMs);
    },
    flush() {
      // Only persist when there is un-saved work; an unload event that fires
      // after the debounce already ran must not double-write.
      if (dirty) run();
      else clear();
    },
    cancel() {
      clear();
      dirty = false;
    },
    get pending() {
      return dirty;
    },
  };
}
