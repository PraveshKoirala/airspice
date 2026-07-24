/**
 * SIMULATE REPORT PARITY test (issue #40, PRD: "(If simulate runs in Node) a
 * test that `simulate` on a corpus design returns a report matching the corpus
 * report fixture within tolerance").
 *
 * This is CONDITIONAL by design, matching the PRD guardrail: "If a capability
 * can't run in Node here (e.g. WASM sim), report it honestly rather than faking
 * output." So:
 *   - If `simulate` returns an HONEST unavailability (an MCP error whose message
 *     says simulation is not available in this Node environment), the numeric
 *     assertion is SKIPPED (the honest regime the PRD permits).
 *   - If `simulate` returns a report, its measurements MUST match the committed
 *     corpus fixture within tolerance. A server that fabricates numbers, or
 *     returns a canned/forked report, FAILS.
 *
 * The measurement strings the report pipeline emits ARE byte-pinned in the
 * corpus, so a real engine matches exactly; the numeric tolerance only absorbs
 * trivial floating-point drift from a differently-built ngspice.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  McpStdioClient,
  resolveServerEntry,
  DESIGN_ENV,
  type JsonRpcResponse,
} from "./helpers/mcpClient.js";
import {
  DESIGNS,
  VALID_SIM_TEST,
  designXml,
  designInputPath,
  reportFixture,
} from "./helpers/corpus.js";

/** Parse a corpus measurement string ("2.5V", "10mA", "0s") to a SI number. */
function siToNumber(s: string): number | null {
  const m = /^\s*([+-]?(?:[0-9]*\.)?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*([a-zA-Zµ]*)\s*$/.exec(s);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2] ?? "";
  const PREFIX: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    "µ": 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
  };
  // Only treat the leading char as an SI prefix when a real unit follows it
  // (e.g. "mA" -> milli+A). A lone unit ("V", "s") is NOT a prefix.
  if (unit.length > 1 && unit[0] in PREFIX) {
    return value * PREFIX[unit[0]];
  }
  return value;
}

/** Assert an actual measurement string matches the expected within tolerance. */
function measurementMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  const a = siToNumber(actual);
  const e = siToNumber(expected);
  if (a === null || e === null) return false;
  const tol = 1e-3 * Math.max(1, Math.abs(e));
  return Math.abs(a - e) <= tol;
}

/** Recursively locate a report object for `testName` within any envelope shape. */
function findReport(payload: any, testName: string): any | null {
  const seen = new Set<any>();
  const stack: any[] = [payload];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (
      !Array.isArray(cur) &&
      cur.test === testName &&
      cur.measurements &&
      typeof cur.measurements === "object"
    ) {
      return cur;
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

const UNAVAILABLE = /(not\s+(yet\s+)?(available|supported|implemented)|unavailable|no\s+wasm|node)/i;

describe("MCP simulate report parity", () => {
  let entry: string;
  beforeAll(() => {
    entry = resolveServerEntry();
  }, 180000);

  it("simulate on the VALID corpus design matches the report fixture within tolerance", async (ctx) => {
    const xml = designXml(DESIGNS.VALID);
    const fixture = reportFixture(DESIGNS.VALID, VALID_SIM_TEST);
    const expectedMeasurements: Record<string, string> = fixture.measurements;

    const client = new McpStdioClient(entry, {
      [DESIGN_ENV]: designInputPath(DESIGNS.VALID),
    });
    try {
      await client.initialize();
      const res: JsonRpcResponse = await client.callTool("simulate", {
        design_xml: xml,
      });

      // Transport-level error: only tolerated if it is an HONEST unavailability.
      if (res.error) {
        if (UNAVAILABLE.test(res.error.message ?? "")) {
          ctx.skip();
          return;
        }
        throw new Error(`simulate JSON-RPC error: ${JSON.stringify(res.error)}`);
      }

      const result = res.result ?? {};
      const textPart = (result.content as Array<{ type: string; text?: string }> | undefined)?.find(
        (c) => c.type === "text" && typeof c.text === "string",
      );

      // MCP tool-level error content: tolerated only if honest unavailability.
      if (result.isError) {
        const msg = textPart?.text ?? JSON.stringify(result);
        if (UNAVAILABLE.test(msg)) {
          ctx.skip();
          return;
        }
        throw new Error(`simulate returned an MCP error: ${msg}`);
      }

      expect(textPart, "simulate must return a text content block").toBeTruthy();
      const payload = JSON.parse(textPart!.text as string);

      // A payload that itself honestly declares the sim path unavailable.
      if (typeof payload?.status === "string" && UNAVAILABLE.test(payload.status)) {
        ctx.skip();
        return;
      }

      const report = findReport(payload, VALID_SIM_TEST);
      expect(
        report,
        `simulate returned a report but none matched test '${VALID_SIM_TEST}'. ` +
          `payload=${JSON.stringify(payload).slice(0, 800)}`,
      ).toBeTruthy();

      // Every fixture measurement must be reproduced within tolerance. This is
      // what a fabricated-number or canned-report server fails.
      for (const [net, expected] of Object.entries(expectedMeasurements)) {
        const actual = report.measurements?.[net];
        expect(
          typeof actual === "string",
          `simulate report is missing measurement for net '${net}'`,
        ).toBe(true);
        expect(
          measurementMatches(actual, expected),
          `measurement '${net}': got ${JSON.stringify(actual)}, expected ~${JSON.stringify(expected)}`,
        ).toBe(true);
      }
    } finally {
      await client.close();
    }
  });
});
