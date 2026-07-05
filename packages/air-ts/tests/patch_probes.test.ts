/**
 * Patch-engine differential probes (issue #11): six+ hand-picked cases that
 * stress exactly where a naive port diverges from CPython's ElementTree, each
 * pinned to the oracle bytes captured from `ET.tostring` / `apply_patch_tree`
 * (see the probe table in the PR). These complement the fixture parity suite
 * (patch_parity.test.ts) with legible, single-behavior assertions.
 *
 * The oracle bytes below were captured directly from the live Python oracle
 * (packages/core/src/air/patches.py + xml.etree.ElementTree). They are the
 * reference side of the differential probe; if the oracle changes, they change.
 */

import { describe, expect, it } from "vitest";
import {
  applyPatch,
  previewPatch,
  applyPatchTree,
  patchOperations,
  PatchError,
  parseXml,
} from "../src/index.js";
import type { XmlElement } from "../src/xml.js";

const DESIGN = `<system name="s" ir_version="0.1">
  <nets>
    <net id="1" role="power"/>
    <net id="10" role="ground"/>
    <net id="2" role="analog_signal"/>
  </nets>
  <components>
    <component id="R1" type="resistor"><value>1k</value><pin name="1" net="1"/><pin name="2" net="2"/></component>
    <component id="R2" type="resistor"><value>2k</value><pin name="1" net="2"/><pin name="2" net="10"/></component>
  </components>
</system>`;

describe("patch differential probes vs the live oracle", () => {
  // PROBE 1 (house specialty): a numeric-looking net id in a patch predicate.
  // ElementTree matches [@id='10'] by string equality; a naive integer-coercing
  // path resolver would confuse '10' and 10. The remove must hit net id="10".
  it("probe 1: numeric net id in a predicate targets by string equality", () => {
    const patch = `<patch><remove path="/system/nets/net[@id='10']"/></patch>`;
    const out = applyPatch(DESIGN, patch);
    expect(out).toContain('<net id="1" role="power"/>');
    expect(out).toContain('<net id="2" role="analog_signal"/>');
    expect(out).not.toContain('id="10"');
  });

  // PROBE 2: targeting a nonexistent component raises the oracle's exact message.
  it("probe 2: patch targeting a nonexistent component throws not-found", () => {
    const patch = `<patch><replace path="/system/components/component[@id='NOPE']/value"><value>9k</value></replace></patch>`;
    expect(() => applyPatch(DESIGN, patch)).toThrowError(PatchError);
    try {
      applyPatch(DESIGN, patch);
    } catch (e) {
      expect((e as PatchError).message).toBe(
        "Patch path not found: /system/components/component[@id='NOPE']/value",
      );
    }
  });

  // PROBE 3: a conflicting two-op patch -- remove R2, then replace R2's value.
  // The oracle applies ops in order; the second op fails not-found after the
  // first removed the node. (The message reports the SECOND op's raw path.)
  it("probe 3: conflicting remove-then-replace fails on the second op", () => {
    const patch = `<patch><remove path="/system/components/component[@id='R2']"/><replace path="/system/components/component[@id='R2']/value"><value>3k</value></replace></patch>`;
    try {
      applyPatch(DESIGN, patch);
      throw new Error("expected a PatchError");
    } catch (e) {
      expect(e).toBeInstanceOf(PatchError);
      expect((e as PatchError).message).toBe(
        "Patch path not found: /system/components/component[@id='R2']/value",
      );
    }
  });

  // PROBE 4: an empty (reason-only) patch is a no-op; the canonical output equals
  // the canonicalized design and preview.operations is [].
  it("probe 4: empty (reason-only) patch is a no-op", () => {
    const empty = `<patch><reason>nothing to do</reason></patch>`;
    const preview = previewPatch(DESIGN, empty);
    expect(preview.operations).toEqual([]);
    // No-op apply == canonicalize(design) == applying a truly empty patch too.
    const out = applyPatch(DESIGN, empty);
    const outBare = applyPatch(DESIGN, `<patch></patch>`);
    expect(out).toBe(outBare);
  });

  // PROBE 5: ET.tostring payload serialization -- self-closing gets a SPACE
  // before '/>', attributes keep DOCUMENT order (NOT sorted), and the payload
  // includes the element's tail. Oracle: `<pin name="1" net="a" />` (note: the
  // attribute order is name-then-net as written, not alphabetized).
  it("probe 5: preview payload matches ET.tostring (space-slash, doc-order attrs, tail)", () => {
    const patch =
      `<patch><add path="/system/components">` +
      `<component id="X" type="resistor"><pin name="1" net="a"/></component>` +
      `</add></patch>`;
    const [op] = patchOperations(parseXml(patch));
    expect(op!.payload).toBe(
      '<component id="X" type="resistor"><pin name="1" net="a" /></component>',
    );
    // Whitespace tail after the payload element is included (oracle behavior).
    const withTail = `<patch><replace path="/a">\n    <value>1M</value>\n  </replace></patch>`;
    const [op2] = patchOperations(parseXml(withTail));
    expect(op2!.payload).toBe("<value>1M</value>\n  ");
  });

  // PROBE 6: normalizer edge input reaching the patch preview -- an add op whose
  // payload has special characters escapes them as ET does (& < > in text; " in
  // attrs), and > IS escaped in text.
  it("probe 6: payload escaping matches ET (amp/lt/gt in text, quot in attr)", () => {
    const patch =
      `<patch><add path="/system/components">` +
      `<component id="A&amp;B" label="he said &quot;hi&quot;"><note>a &lt; b &amp; c &gt; d</note></component>` +
      `</add></patch>`;
    const [op] = patchOperations(parseXml(patch));
    expect(op!.payload).toBe(
      '<component id="A&amp;B" label="he said &quot;hi&quot;">' +
        "<note>a &lt; b &amp; c &gt; d</note></component>",
    );
  });

  // PROBE 7 (raw-tree): applyPatchTree does not mutate the input design root.
  it("probe 7: applyPatchTree leaves the input tree untouched (deepcopy semantics)", () => {
    const designRoot = parseXml(DESIGN);
    const before = JSON.stringify(serialize(designRoot));
    const patchRoot = parseXml(
      `<patch><remove path="/system/components/component[@id='R2']"/></patch>`,
    );
    applyPatchTree(designRoot, patchRoot);
    const after = JSON.stringify(serialize(designRoot));
    expect(after).toBe(before);
  });
});

/** Minimal structural snapshot of an element (tag + attrs + child tags). */
function serialize(el: XmlElement): unknown {
  return {
    tag: el.tag,
    attrib: [...el.attrib.entries()],
    children: el.children.map((c) =>
      c.kind === "element" ? serialize(c) : { text: c.value },
    ),
  };
}
