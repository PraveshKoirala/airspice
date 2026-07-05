/**
 * The repair-benchmark CLI (issue #19 deliverable 3, LIVE mode).
 *
 *   npm run bench                      # mock mode (deterministic, no network)
 *   npm run bench -- --provider gemini # live: real Gemini, needs GEMINI_API_KEY
 *   npm run bench -- --provider anthropic --model claude-sonnet-5
 *
 * Live mode drives each failing example through the loop with a REAL provider
 * (BYOK — the key is read from the environment for a local run only; it never
 * enters the repo). The scored report is written to
 * bench/results/<date>-<provider>.json so quality is tracked over time.
 *
 * air-ts is imported here by RELATIVE SOURCE PATH (not the bare `air-ts`
 * specifier) so this runs under `tsx` with no bundler alias; the aliased
 * import inside prompts.ts is handled by the `bench/air-ts-loader.mjs` resolve
 * hook the npm script wires in via --import.
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
} from "../../air-ts/src/index.js";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  type AgentProvider,
} from "../src/index.js";
import { runBenchmark, serializeReport, type AirTsFacade } from "./runner.js";

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
  maxIterations: number;
  caseDelayMs?: number;
  providerErrorRetries?: number;
  retryCooldownMs?: number;
  only?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { provider: "mock", maxIterations: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--provider") args.provider = argv[++i] ?? "mock";
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--max-iterations") args.maxIterations = Number(argv[++i] ?? 5);
    else if (a === "--case-delay-ms") args.caseDelayMs = Number(argv[++i] ?? 0);
    else if (a === "--provider-error-retries") args.providerErrorRetries = Number(argv[++i] ?? 0);
    else if (a === "--retry-cooldown-ms") args.retryCooldownMs = Number(argv[++i] ?? 0);
    else if (a === "--only") args.only = (argv[++i] ?? "").split(",").filter(Boolean);
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
      `No ${name} in the environment. Set it (or use a .env) for a live bench run. ` +
        `The key is never committed.`,
    );
  }
  return key;
}

/** Minimal .env reader (KEY=VALUE lines) so a local `.env` is honored. */
function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = join(here, "../../../.env");
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

  console.log(`Repair benchmark — mode=${mode} provider=${args.provider} maxIterations=${args.maxIterations}`);
  console.log("─".repeat(72));

  const report = await runBenchmark({
    air,
    mode,
    providerLabel: args.provider,
    ...(args.model ? { model: args.model } : {}),
    maxIterations: args.maxIterations,
    ...(args.caseDelayMs !== undefined ? { caseDelayMs: args.caseDelayMs } : {}),
    ...(args.providerErrorRetries !== undefined ? { providerErrorRetries: args.providerErrorRetries } : {}),
    ...(args.retryCooldownMs !== undefined ? { retryCooldownMs: args.retryCooldownMs } : {}),
    ...(args.only ? { only: args.only } : {}),
    ...(mode === "live" ? { makeLiveProvider: () => makeProvider(args.provider, args.model) } : {}),
    onCase: (c) => {
      const mark = c.fixed ? "FIXED" : "not fixed";
      console.log(
        `  ${c.name.padEnd(24)} ${mark.padEnd(10)} iters=${c.iterations} tokens=${c.tokens} stop=${c.stopReason}`,
      );
    },
  });

  console.log("─".repeat(72));
  console.log(`Result: ${report.fixedCount}/${report.totalCases} fixed within ${report.maxIterations} iterations.`);

  const here = dirname(fileURLToPath(import.meta.url));
  const resultsDir = join(here, "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = join(resultsDir, `${report.date}-${args.provider}.json`);
  writeFileSync(outPath, serializeReport(report), "utf-8");
  console.log(`Wrote ${outPath}`);

  // A live baseline that misses the target is a P0 FINDING, surfaced (not hidden).
  if (mode === "live" && report.fixedCount < 4) {
    console.log(
      `\nP0 FINDING: only ${report.fixedCount}/6 fixed — below the >=4/6 target. ` +
        `Document per-case deltas on issue #19.`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
