/**
 * The build-benchmark CLI (issue #107 deliverable 3, LIVE mode).
 *
 *   npm run build-bench                              # mock (deterministic, no net)
 *   npm run build-bench -- --provider anthropic --model claude-sonnet-5
 *   npm run build-bench -- --provider anthropic --only <spec_id>[,<spec_id>...]
 *   npm run build-bench -- --provider anthropic --limit 5
 *
 * Live mode drives each spec's NL prompt through the build loop with a REAL
 * provider (BYOK — the key is read from the environment / .env for a local run
 * only; it never enters the repo) and scores the built design with the OBJECTIVE
 * Python scorer (real ngspice). The scored report is written to
 * bench/results/build-<date>-<provider>.json.
 *
 * air-ts is imported by RELATIVE SOURCE path so this runs under tsx; the aliased
 * `air-ts` specifier inside prompts.ts is resolved by the paths map in
 * bench/tsconfig.bench.json (via --tsconfig), exactly as the repair bench does.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalize,
  validate,
  applyPatch,
  previewPatch,
  COMPONENT_SPECS,
  MCUS,
} from "../../../air-ts/src/index.js";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  type AgentProvider,
} from "../../src/index.js";
import { runBuildBenchmark, serializeBuildReport, type AirTsFacade } from "./runner.js";
import { repoRoot } from "./specs.js";
import { mockFixtureForSpec } from "./mock_fixtures.js";

const air: AirTsFacade = {
  normalize,
  validate: validate as unknown as AirTsFacade["validate"],
  applyPatch,
  previewPatch: previewPatch as unknown as AirTsFacade["previewPatch"],
  COMPONENT_SPECS: COMPONENT_SPECS as Record<string, unknown>,
  MCUS: MCUS as Record<string, unknown>,
};

interface Args {
  provider: string;
  model?: string;
  pythonBin?: string;
  specDelayMs?: number;
  only?: string[];
  limit?: number;
  saveDesignsDir?: string;
  perSpecTokenCap?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { provider: "mock" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.provider = argv[++i] ?? "mock";
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--python") args.pythonBin = argv[++i];
    else if (a === "--spec-delay-ms") args.specDelayMs = Number(argv[++i] ?? 0);
    else if (a === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--limit") args.limit = Number(argv[++i] ?? 0);
    else if (a === "--save-designs") args.saveDesignsDir = argv[++i];
    else if (a === "--per-spec-token-cap") args.perSpecTokenCap = Number(argv[++i] ?? 0);
  }
  return args;
}

/** Read a provider API key from the environment (local run only). */
function envKey(provider: string): string {
  const map: Record<string, string> = {
    gemini: "GEMINI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  const name = map[provider];
  if (!name) throw new Error(`Unknown live provider '${provider}'.`);
  const key = process.env[name];
  if (!key) {
    throw new Error(
      `No ${name} in the environment. Set it (or use a .env) for a live build-bench run. ` +
        `The key is never committed.`,
    );
  }
  return key;
}

/** Minimal .env reader (KEY=VALUE lines) so a local `.env` is honored. */
function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = join(here, "../../../../.env");
    const text = readFileSync(envPath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] && !(m[1] in process.env)) {
        process.env[m[1]] = (m[2] ?? "").replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // No .env — rely on the real environment.
  }
}

function makeProvider(provider: string, model?: string): AgentProvider {
  const apiKey = envKey(provider);
  const opts = model ? { apiKey, model } : { apiKey };
  switch (provider) {
    case "gemini":
      return new GeminiProvider(opts);
    case "anthropic":
      return new AnthropicProvider(opts);
    case "openai":
      return new OpenAIProvider(opts);
    default:
      throw new Error(`Unknown live provider '${provider}'.`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const mode: "mock" | "live" = args.provider === "mock" ? "mock" : "live";
  const root = repoRoot();
  const pythonBin = args.pythonBin ?? process.env["AIR_PYTHON"] ?? "python";

  console.log(
    `Build benchmark — mode=${mode} provider=${args.provider}` +
      (args.model ? ` model=${args.model}` : "") +
      (args.only ? ` only=${args.only.join(",")}` : "") +
      (args.limit !== undefined ? ` limit=${args.limit}` : ""),
  );
  console.log("─".repeat(84));

  const report = await runBuildBenchmark({
    air,
    mode,
    repoRoot: root,
    pythonBin,
    providerLabel: args.provider,
    ...(args.model ? { model: args.model } : {}),
    ...(args.specDelayMs !== undefined ? { specDelayMs: args.specDelayMs } : {}),
    ...(args.only ? { only: args.only } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.saveDesignsDir ? { saveDesignsDir: args.saveDesignsDir } : {}),
    ...(args.perSpecTokenCap !== undefined ? { perSpecTokenCap: args.perSpecTokenCap } : {}),
    ...(mode === "mock" ? { mockFixtureForSpec } : {}),
    ...(mode === "live" ? { makeLiveProvider: () => makeProvider(args.provider, args.model) } : {}),
    onCase: (c) => {
      const mark = c.built ? "BUILT" : "not built";
      const crit = c.built ? "" : ` failed=${c.failedCriterion ?? c.stopReason}`;
      console.log(
        `  ${c.id.padEnd(30)} ${mark.padEnd(10)} turns=${c.turns} tokens=${c.tokens} stop=${c.stopReason}${crit}`,
      );
    },
  });

  console.log("─".repeat(84));
  console.log(`Result: ${report.builtCount}/${report.totalSpecs} built.`);

  const here = dirname(fileURLToPath(import.meta.url));
  const resultsDir = join(here, "..", "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `build-${report.date}-${args.provider}.json`);
  writeFileSync(outPath, serializeBuildReport(report), "utf-8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
