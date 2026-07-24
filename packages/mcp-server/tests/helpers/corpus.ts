/**
 * Golden-corpus accessors for the mcp-server tests (issue #40). The corpus is
 * the SAME `tests/golden_corpus/**` fixture tree the air-ts parity suite reads;
 * we reuse it so the MCP server's outputs are checked against the exact designs
 * and report fixtures the deterministic engine is already pinned to.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/mcp-server/tests/helpers
/** repo root: helpers -> tests -> mcp-server -> packages -> root */
export const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
export const CORPUS_DIR = join(REPO_ROOT, "tests", "golden_corpus");

/**
 * Named corpus designs the tests reference. Chosen by PROPERTY, not by accident:
 *  - VALID:        validates clean (zero diagnostics), no firmware block.
 *  - FAILING:      validates with error-severity diagnostics (non-empty).
 *  - FIRMWARE:     valid design that DOES contain a firmware block (gates
 *                  `run_cosim` in tools/list).
 * The `simulate` fixture below belongs to VALID.
 */
export const DESIGNS = {
  VALID: "analog_primitives",
  FAILING: "failing_missing_ground",
  FIRMWARE: "esp32_battery_sensor",
} as const;

/** The single test in the VALID design that has a committed report fixture. */
export const VALID_SIM_TEST = "divider_with_load";

/** Absolute path to a design's canonical input document. */
export function designInputPath(name: string): string {
  return join(CORPUS_DIR, name, "input.air.xml");
}

/** The AIR XML source of a corpus design. */
export function designXml(name: string): string {
  return readFileSync(designInputPath(name), "utf8");
}

/** A committed per-test report fixture (`report/reports/<test>.json`), parsed. */
export function reportFixture(design: string, test: string): any {
  return JSON.parse(
    readFileSync(
      join(CORPUS_DIR, design, "report", "reports", `${test}.json`),
      "utf8",
    ),
  );
}
