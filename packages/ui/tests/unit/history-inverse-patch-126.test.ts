/**
 * Issue #126 -- schematic history records MINIMAL inverse patches, not a
 * whole-document snapshot / root-replace, while preserving byte-exact
 * undo/redo.
 *
 * Three facets:
 *
 *   1) BYTE-EXACTNESS (representation-agnostic -- must pass now and after the
 *      fix): a sequence of single-element value edits, then
 *      undo/undo/redo/redo, restores the design XML byte-for-byte at every
 *      step. Driven through the public performUndo/performRedo API against the
 *      design store, so it holds whether history restores snapshots (current)
 *      or applies inverse patches (target).
 *
 *   2) MINIMAL-PATCH MEMORY (FAILS against the current whole-document
 *      representation; passes only with minimal changed-element patches):
 *      after a single-attribute edit on a LARGE design, the recorded
 *      `undoPatch` and `redoPatch` are (a) genuine functional inverse patches
 *      -- verified by applying them with air-ts -- and (b) each far smaller
 *      than the full document (< 25%). The functional check means a `""` stub
 *      cannot pass; the size check means a whole-document root-replace cannot
 *      pass. Both together make the memory assertion genuine.
 *
 *   3) FALLBACK (representation-agnostic): a structural edit that cannot be
 *      minimally inverted (component removal) still undoes/redoes byte-exactly
 *      via the root-replace fallback path.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { applyPatch, normalize } from "air-ts";

import { commitPatch } from "../../src/schematic/gate";
import { replaceValuePatch } from "../../src/schematic/patches";
import {
  performRedo,
  performUndo,
  resetHistory,
  useHistoryStore,
} from "../../src/schematic/history";
import { useDesignStore } from "../../src/agent/designStore";
import { DEFAULT_DESIGN_XML, buildLargeDesign, padId } from "./fixtures";

/** Loose view -- `undoPatch`/`redoPatch` are the #126 target fields. */
interface EntryView {
  source: string;
  before?: string;
  after?: string;
  undoPatch?: unknown;
  redoPatch?: unknown;
}

function topEntry(): EntryView {
  const stack = useHistoryStore.getState().undoStack;
  return stack[stack.length - 1] as unknown as EntryView;
}

function xml(): string {
  return useDesignStore.getState().xml;
}

function seed(design: string): string {
  const canonical = normalize(design);
  useDesignStore.getState().setUserXml(canonical);
  resetHistory();
  return canonical;
}

beforeEach(() => {
  useDesignStore.setState({ xml: "", version: 0 });
  resetHistory();
});

describe("#126 byte-exact undo/redo", () => {
  it("restores byte-exact XML through undo/undo/redo/redo of single-element edits", () => {
    const s0 = seed(DEFAULT_DESIGN_XML);

    // Two single-element edits on the same component (capacitor value: an
    // electrically-inert change that the analytic validators always accept).
    expect(commitPatch(replaceValuePatch("C_BAT_SENSE", "220nF"), "inspector", "e1").ok).toBe(true);
    const s1 = xml();
    expect(commitPatch(replaceValuePatch("C_BAT_SENSE", "470nF"), "inspector", "e2").ok).toBe(true);
    const s2 = xml();

    // Three genuinely distinct canonical states.
    expect(s1).not.toBe(s0);
    expect(s2).not.toBe(s1);
    expect(s2).not.toBe(s0);

    // Undo back down the stack.
    performUndo();
    expect(xml()).toBe(s1);
    performUndo();
    expect(xml()).toBe(s0);

    // Redo back up the stack.
    performRedo();
    expect(xml()).toBe(s1);
    performRedo();
    expect(xml()).toBe(s2);
  });
});

describe("#126 minimal-patch memory", () => {
  it("records undo/redo patches far smaller than a large document", () => {
    const before = seed(buildLargeDesign(80));
    // The large design must be genuinely large for the 25% threshold to bite.
    expect(before.length).toBeGreaterThan(4000);

    const target = padId(40); // a single interior component
    const res = commitPatch(
      replaceValuePatch(target, "2k"),
      "inspector",
      `${target}.value = 2k`,
    );
    expect(res.ok).toBe(true);
    const after = xml();
    expect(after).not.toBe(before);

    const entry = topEntry();
    expect(entry.source).toBe("inspector");

    // (a) The recorded inverse patches must EXIST as patch strings. Against
    //     the current whole-document snapshot representation there is no
    //     undoPatch/redoPatch, so these assertions fail first -- exactly the
    //     "#126 fails now" expectation.
    expect(typeof entry.redoPatch).toBe("string");
    expect(typeof entry.undoPatch).toBe("string");
    const redoPatch = entry.redoPatch as string;
    const undoPatch = entry.undoPatch as string;
    expect(redoPatch.length).toBeGreaterThan(0);
    expect(undoPatch.length).toBeGreaterThan(0);

    // (b) They must be GENUINE functional inverse patches: applying redoPatch
    //     to `before` reproduces `after`, and applying undoPatch to `after`
    //     restores `before` -- byte-exact. A "" stub (or a bogus patch) fails
    //     here even though it would trivially satisfy the size check below.
    expect(normalize(applyPatch(before, redoPatch))).toBe(after);
    expect(normalize(applyPatch(after, undoPatch))).toBe(before);

    // (c) MEMORY: each patch must be far smaller than the whole document.
    //     A whole-document buildReplaceRootPatch (~100% of the doc) fails
    //     this; a minimal changed-element replace (~1% here) passes.
    expect(redoPatch.length).toBeLessThan(after.length * 0.25);
    expect(undoPatch.length).toBeLessThan(before.length * 0.25);
  });
});

describe("#126 coarser-than-element fallback for non-minimally-invertible edits", () => {
  it("records a whole-section/root replace (not a minimal element patch) and still undoes/redoes byte-exactly", () => {
    const s0 = seed(DEFAULT_DESIGN_XML);

    // Edit a NON-id-keyed section (<metadata><title>). There is no single
    // components/component[@id=...] element to invert, so the minimal
    // changed-element logic cannot build an element patch and MUST fall back
    // to the whole-document buildReplaceRootPatch.
    //
    // NOTE (why not a component <remove>): the canonicalizer sorts
    // <components> by id, so a remove/add round-trips byte-exact and is
    // adopted as a MINIMAL patch -- it never reaches the fallback branch. A
    // metadata edit genuinely cannot be minimally inverted, so it does.
    const titlePatch =
      `<patch><replace path="metadata/title"><title>Renamed Sensor Board</title></replace></patch>`;
    const res = commitPatch(titlePatch, "inspector", "retitle");
    expect(res.ok).toBe(true);
    const s1 = xml();
    expect(s1).not.toBe(s0);

    const entry = topEntry();
    expect(typeof entry.redoPatch).toBe("string");
    expect(typeof entry.undoPatch).toBe("string");
    const redoPatch = entry.redoPatch as string;
    const undoPatch = entry.undoPatch as string;

    // (b) The recorded patches are a COARSER-than-element fallback replace --
    //     a whole-section (e.g. path="metadata") or root (path=".") replace --
    //     NOT the minimal single-component path. This proves the edit fell
    //     back from the minimal changed-element path rather than riding it.
    //     (A minimal edit would carry path="components/component[@id='...']".)
    expect(redoPatch).not.toMatch(/path="components\/component\[/);
    expect(undoPatch).not.toMatch(/path="components\/component\[/);
    expect(redoPatch).toMatch(/<replace path="(metadata|nets|components|\.)"/);
    expect(undoPatch).toMatch(/<replace path="(metadata|nets|components|\.)"/);

    // ...and they remain genuine byte-exact inverse patches (a "" or wrong
    // payload would fail here).
    expect(normalize(applyPatch(s0, redoPatch))).toBe(s1);
    expect(normalize(applyPatch(s1, undoPatch))).toBe(s0);

    // (a) undo/redo through the public API remains byte-exact.
    performUndo();
    expect(xml()).toBe(s0);
    performRedo();
    expect(xml()).toBe(s1);
  });
});
