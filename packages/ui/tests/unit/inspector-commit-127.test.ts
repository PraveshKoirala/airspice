/**
 * Issue #127 -- Inspector edits route through the central commitPatch write
 * path and are labeled `"inspector"` in history (NEVER `"agent"`).
 *
 * Two facets are tested:
 *
 *   A) The write-path CONTRACT (behavioral): `commitPatch(patch, "inspector",
 *      note)` records a history entry whose `source` is exactly the label
 *      passed -- `"inspector"`, not `"agent"`. This proves the central path
 *      threads the source correctly. (Passes against committed gate.ts.)
 *
 *   B) The Inspector ROUTING requirement (source-level): `Inspector.tsx` must
 *      commit its edits through `commitPatch` -- NOT via a raw
 *      `setUserXml(...)` write. A raw `setUserXml` from the Inspector is
 *      captured by the App.tsx design-store subscription and mislabeled
 *      `"agent"` (App.tsx: `pushHistoryEntry(previous, next, 'agent', ...)`),
 *      which is exactly the #127 bug. This test fails while the Inspector
 *      still bypasses commitPatch and passes once it is rewired.
 *
 * These are Node-side unit tests: the zustand stores and the air-ts patch
 * engine run without a DOM, so facet B is asserted by inspecting the
 * Inspector source rather than mounting React (no jsdom in this package).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { normalize } from "air-ts";

import { commitPatch } from "../../src/schematic/gate";
import { replaceValuePatch } from "../../src/schematic/patches";
import { useHistoryStore, resetHistory } from "../../src/schematic/history";
import { useDesignStore } from "../../src/agent/designStore";
import { DEFAULT_DESIGN_XML } from "./fixtures";

/** Loose view of a history entry -- tolerant of the entry shape evolving. */
interface EntryView {
  source: string;
  label: string;
  before?: string;
  after?: string;
}

function topEntry(): EntryView {
  const stack = useHistoryStore.getState().undoStack;
  return stack[stack.length - 1] as unknown as EntryView;
}

function seed(xml: string): void {
  useDesignStore.getState().setUserXml(xml);
  resetHistory();
}

beforeEach(() => {
  useDesignStore.setState({ xml: "", version: 0 });
  resetHistory();
});

describe("#127 commitPatch write-path contract", () => {
  it('labels an inspector commit source "inspector", not "agent"', () => {
    seed(normalize(DEFAULT_DESIGN_XML));

    // A capacitor value change is a benign single-element edit (electrically
    // inert -- it cannot trip the analytic ADC/divider validators).
    const res = commitPatch(
      replaceValuePatch("C_BAT_SENSE", "220nF"),
      "inspector",
      "C_BAT_SENSE.value = 220nF",
    );

    expect(res.ok).toBe(true);
    expect(useHistoryStore.getState().undoStack).toHaveLength(1);

    const entry = topEntry();
    expect(entry.source).toBe("inspector");
    expect(entry.source).not.toBe("agent");
  });

  it("threads the source label through (does not hardcode one)", () => {
    // Guards against a stub that always labels edits "inspector": a drag
    // commit must still be labeled "drag". This keeps facet A honest.
    seed(normalize(DEFAULT_DESIGN_XML));

    const res = commitPatch(
      replaceValuePatch("R_BAT_BOTTOM", "220k"),
      "drag",
      "moved",
    );

    expect(res.ok).toBe(true);
    expect(topEntry().source).toBe("drag");
  });
});

describe("#127 Inspector routes through commitPatch (not raw setUserXml)", () => {
  const inspectorSrc = readFileSync(
    fileURLToPath(new URL("../../src/schematic/Inspector.tsx", import.meta.url)),
    "utf8",
  );

  it("imports and calls commitPatch for its edits", () => {
    // The Inspector's edit commit MUST flow through the central commitPatch
    // path so the history entry is labeled "inspector".
    expect(inspectorSrc).toMatch(/\bcommitPatch\b/);
    expect(inspectorSrc).toMatch(/commitPatch\s*\(/);
  });

  it("does not commit edits via a raw setUserXml() call", () => {
    // A raw `setUserXml(...)` from the Inspector is mislabeled "agent" by the
    // App.tsx external-writer subscription -- the #127 defect. The Inspector
    // must not write the design store directly.
    expect(inspectorSrc).not.toMatch(/setUserXml\s*\(/);
  });
});
