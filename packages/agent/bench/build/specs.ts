/**
 * Build-benchmark spec loading (issue #107, child C of epic #104).
 *
 * Loads the #106 spec corpus (packages/agent/bench/build_specs/specs/*.json).
 * This file lives under bench/ precisely so it MAY read those spec files (a bench
 * loader naming its inputs is the benchmark doing its job); the harness loop +
 * prompts must not name any spec id (grep-clean, like #19's cases.ts).
 *
 * A spec's `criteria` are passed to the OBJECTIVE scorer VERBATIM — the harness
 * never inspects or special-cases them; the agent gets ONLY the NL `prompt`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A required-component criterion: a type + minimum count (+ optional part). */
export interface RequiredComponent {
  readonly type: string;
  readonly count: number;
  readonly part?: string;
}

/** A DC/settled voltage window on a named net (real ngspice). */
export interface SimAssertion {
  readonly net: string;
  readonly min_v: number;
  readonly max_v: number;
}

/** The machine-checkable criteria the objective scorer evaluates. */
export interface BuildCriteria {
  readonly required_components: RequiredComponent[];
  readonly connectivity: string[];
  readonly firmware_intent: string[];
  readonly erc_clean: boolean;
  readonly sim_assertion?: SimAssertion;
}

/** One build spec (the #106 record shape). */
export interface BuildSpec {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  /** The natural-language device spec — the ONLY thing the agent is given. */
  readonly prompt: string;
  readonly mcu: string;
  readonly fidelity: "faithful" | "abstracted";
  readonly criteria: BuildCriteria;
  /** The agent's turn budget for this spec (default 4). */
  readonly turn_budget: number;
  /** Golden design path (relative to build_specs/), present iff a golden exists. */
  readonly golden?: string;
  /** Retained for completeness; abstracted specs carry an abstraction block. */
  readonly abstraction?: unknown;
}

/** Resolve the build_specs directory relative to this module. */
function buildSpecsRoot(): string {
  return fileURLToPath(new URL("../build_specs/", import.meta.url));
}

/** The specs/ directory. */
function specsDir(): string {
  return join(buildSpecsRoot(), "specs");
}

/** Load every build spec, in a stable (sorted-by-id) order. */
export function loadBuildSpecs(): BuildSpec[] {
  const dir = specsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const specs = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as BuildSpec);
  // Stable order by id (files are already sorted, but be explicit).
  specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return specs;
}

/** Read a golden design's XML for a spec (used by the golden-build scorer check). */
export function loadGoldenXml(spec: BuildSpec): string | null {
  if (!spec.golden) return null;
  return readFileSync(join(buildSpecsRoot(), spec.golden), "utf-8");
}

/** The absolute repo root (four levels up from build_specs/specs). */
export function repoRoot(): string {
  // build/ -> bench/ -> agent/ -> packages/ -> repo root
  return dirname(dirname(dirname(dirname(dirname(specsDir())))));
}
