/**
 * Deterministic mock build fixtures (issue #107).
 *
 * This module lives under bench/ so it MAY read the golden designs (a bench
 * fixture naming its inputs is the benchmark doing its job; the harness loop +
 * prompts name no spec — grep-clean like #19). For a spec that ships a GOLDEN
 * design (#106's known-good, criteria-passing reference), the mock provider
 * stages that golden verbatim via set_design: it passes the REAL air-ts gate and,
 * scored objectively, is BUILT. For a spec without a golden the mock stages
 * nothing — the loop records an honest no_build.
 *
 * This drives the CLI's `npm run build-bench` (mock) end to end against the real
 * scorer locally. The CI vitest test (bench.test.ts) uses these same fixtures but
 * INJECTS a deterministic scorer so it runs offline (no python / ngspice); the
 * real scorer's discrimination is proven separately by tests/test_build_specs.py.
 */

import type { MockFixture, ScriptedEvent } from "../../src/index.js";
import { loadGoldenXml, type BuildSpec } from "./specs.js";
import { stageDesignTurns } from "./runner.js";

/**
 * The mock fixture for one spec: stage its golden design (a build) if it has one,
 * else a single terminal turn that stages nothing (an honest no_build).
 */
export function mockFixtureForSpec(spec: BuildSpec): MockFixture {
  const golden = loadGoldenXml(spec);
  if (golden) {
    return {
      turns: stageDesignTurns(golden, `Golden build for ${spec.category}`, `build-${spec.id}`),
    };
  }
  const noStage: ScriptedEvent[] = [
    { type: "text-delta", text: "I need more information to build this." },
    { type: "usage", inputTokens: 30, outputTokens: 10 },
    { type: "done", stopReason: "stop" },
  ];
  return { turns: [noStage] };
}
