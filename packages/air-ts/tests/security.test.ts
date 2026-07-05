/**
 * XML security contract tests (issue #7 deliverable 4 + post-audit amendment 3).
 *
 * These are conservative PRE-#43 defaults (documented as such in xml.ts): reject
 * DOCTYPE and entity declarations outright, cap input at 5 MB, cap nesting depth
 * at 64. The formal contract lands in #43's docs/xml_security.md; encoding the
 * rejection now (rather than retrofitting) keeps early fixtures honest.
 */

import { describe, it, expect } from "vitest";
import { parse, XmlSecurityError, XmlParseError } from "../src/index.js";
import {
  parseXml,
  MAX_INPUT_BYTES,
  MAX_DEPTH,
} from "../src/xml.js";

describe("XML security limits", () => {
  it("rejects DOCTYPE declarations", () => {
    expect(() => parse('<!DOCTYPE foo><system name="t" ir_version="0.1"/>')).toThrow(
      XmlSecurityError,
    );
  });

  it("rejects internal entity declarations (XXE surface)", () => {
    const xml =
      '<!DOCTYPE lolz [<!ENTITY a "boom">]><system name="t" ir_version="0.1"/>';
    expect(() => parse(xml)).toThrow(XmlSecurityError);
  });

  it("rejects a standalone ENTITY declaration", () => {
    // Even without DOCTYPE the ENTITY token is refused.
    expect(() => parse('<!ENTITY x "y"><system/>')).toThrow(XmlSecurityError);
  });

  it("rejects input beyond the size cap", () => {
    // Build a document just over the byte cap cheaply (padding inside a comment
    // would be dropped, so pad an attribute value instead).
    const pad = "x".repeat(MAX_INPUT_BYTES + 1);
    const xml = `<system name="${pad}" ir_version="0.1"/>`;
    expect(() => parse(xml)).toThrow(XmlSecurityError);
  });

  it("rejects nesting deeper than the depth cap", () => {
    const depth = MAX_DEPTH + 5;
    const open = "<a>".repeat(depth);
    const close = "</a>".repeat(depth);
    const xml = `<system>${open}${close}</system>`;
    expect(() => parseXml(xml)).toThrow(XmlSecurityError);
  });

  it("accepts a document at a safe depth", () => {
    const open = "<a>".repeat(10);
    const close = "</a>".repeat(10);
    expect(() => parseXml(`<system>${open}${close}</system>`)).not.toThrow();
  });

  it("throws XmlParseError (not a crash) on malformed XML", () => {
    expect(() => parseXml("<system><a></system>")).toThrow(XmlParseError);
  });
});
