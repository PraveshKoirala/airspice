// Deterministic circuit-refinement harness.
//
// Drives the REAL AirSpice webapp (dev server + local LLM proxy) through each
// corpus spec end-to-end and records a structured verdict, so app bugs are
// separated from circuit-level non-convergence.
//
//   node qa/run-circuits.mjs [--start N] [--count M] [--ids a,b,c]
//                            [--concurrency K] [--base URL] [--out DIR]
//
// Per spec (each in an isolated browser context):
//   1. load /project, force a BLANK design via the dev hook
//   2. type the prompt, send, wait for the agent run to finish
//   3. if a proposal staged with a VISIBLE Apply button, click it
//   4. run the simulation, capture pass/fail
//   5. if the spec expects firmware, open the Firmware tab and check it renders
//   6. record page/console errors, the final XML, transcript tail, a verdict
//
// Results stream to <out>/results.jsonl (one line per spec) so a crash keeps
// progress; a summary prints at the end.

import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = parseArgs(process.argv.slice(2));
const BASE = argv.base ?? "http://localhost:5199";
const CONCURRENCY = Number(argv.concurrency ?? 4);
const OUT = resolve(argv.out ?? `${HERE}/circuit-corpus/results`);
const RUN_TIMEOUT_MS = Number(argv.timeout ?? 220000);
mkdirSync(OUT, { recursive: true });
mkdirSync(`${OUT}/shots`, { recursive: true });

const ALL = JSON.parse(readFileSync(`${HERE}/circuit-corpus/prompts.json`, "utf8"));
let specs = ALL;
if (argv.ids) {
  const set = new Set(argv.ids.split(","));
  specs = ALL.filter((s) => set.has(s.id));
} else {
  const start = Number(argv.start ?? 0);
  const count = argv.count ? Number(argv.count) : ALL.length;
  specs = ALL.slice(start, start + count);
}

const BLANK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<system name="blank_design" ir_version="0.1">
  <metadata><title>Blank Design</title><description>Fresh blank design.</description></metadata>
  <nets><net id="gnd" role="ground"/></nets>
  <components/>
  <simulation_profiles/>
</system>`;

const resultsPath = `${OUT}/results.jsonl`;
writeFileSync(resultsPath, "");
console.log(`Running ${specs.length} specs against ${BASE}, concurrency ${CONCURRENCY}`);
console.log(`Results -> ${resultsPath}\n`);

const browser = await chromium.launch();
const results = [];
let idx = 0;
async function worker(wid) {
  while (idx < specs.length) {
    const myIdx = idx++;
    const spec = specs[myIdx];
    const t0 = Date.now();
    let res;
    try {
      res = await runSpec(spec);
    } catch (err) {
      res = {
        verdict: "harness-error",
        error: String(err && err.message ? err.message : err),
      };
    }
    res = { id: spec.id, title: spec.title, mcu: spec.mcu, category: spec.category, ...res, ms: Date.now() - t0 };
    results.push(res);
    appendFileSync(resultsPath, JSON.stringify(res) + "\n");
    const flag = res.verdict.startsWith("bug") ? "🐛" : res.verdict === "ok" ? "✅" : res.verdict.startsWith("review") || res.verdict.startsWith("agent") ? "⚠️ " : "❓";
    console.log(`${flag} [${results.length}/${specs.length}] ${spec.id} → ${res.verdict}${res.simStatus ? ` (sim:${res.simStatus})` : ""} ${Math.round(res.ms / 1000)}s`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
await browser.close();

// ---- summary ----
const byVerdict = {};
for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
const bugs = results.filter((r) => r.verdict.startsWith("bug") || r.verdict === "harness-error");
const summary = {
  total: results.length,
  byVerdict,
  mcuBuiltAndRendered: results.filter((r) => r.category === "mcu" && r.applied && r.firmwarePresent).length,
  simPassed: results.filter((r) => r.simStatus === "passed").length,
  bugs: bugs.map((b) => ({ id: b.id, verdict: b.verdict, detail: b.bugDetail || b.error })),
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log("\n==== SUMMARY ====");
console.log(JSON.stringify(summary, null, 2));

// ------------------------------------------------------------------ //

async function runSpec(spec) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  // Optional model override: seed the persisted agent-settings store before the
  // app boots so the harness can target a specific proxy model (e.g. when the
  // default is rate-limited). Vault key/baseUrl are still auto-seeded at boot.
  if (argv.model) {
    await page.addInitScript((model) => {
      localStorage.setItem(
        "airspice.agent.settings",
        JSON.stringify({
          state: { agentProvider: "openai", agentModel: model, freeTextModel: model, autoApply: false, malformedCount: 0, tokenBudget: 4096 },
          version: 2,
        }),
      );
    }, argv.model);
  }
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") {
      const t = m.text();
      // React DevTools nag + HMR noise are not product bugs.
      if (/Download the React DevTools|\[vite\]/.test(t)) return;
      // ngspice engine diagnostics (piped from the WASM worker's stderr) are
      // SIMULATION-domain messages, not app JS errors — a non-convergent circuit
      // is a circuit fact, surfaced in the sim panel, not a webapp bug. These
      // arrive line-by-line, including blank lines and continuation fragments.
      if (t.trim() === "") return;
      if (/singular matrix|gmin stepping|Timestep too small|doAnalyses|checkvalid|operating point|source stepping|Transient op|run simulation|Error during 'write'|zero length|initial timepoint|d-instance|The operating point|steps may fail|aborted|Warning:|Note:|^\s*!/i.test(t)) return;
      consoleErrors.push(t.slice(0, 300));
    }
  });

  const out = {};
  try {
    await page.goto(`${BASE}/project`, { waitUntil: "networkidle", timeout: 40000 });
    await page.waitForSelector('[data-testid="schematic-svg"]', { timeout: 25000 });
    // Force a blank starting design so every build is fresh (not a patch of the
    // first-run ESP32 default).
    await page.waitForFunction(() => typeof window.__airSetXml === "function", null, { timeout: 10000 });
    await page.evaluate((xml) => window.__airSetXml(xml), BLANK_XML);
    await page.waitForTimeout(400);

    // Send the prompt.
    const ta = page.locator(".chat-input-area textarea");
    await ta.fill(spec.prompt);
    await page.locator('[data-testid="agent-send"]').click();

    // Wait for the run to finish: the loading row appears while running and is
    // removed when the run ends.
    await page.waitForTimeout(1500);
    await page
      .waitForFunction(() => !document.querySelector(".message.loading"), null, {
        timeout: RUN_TIMEOUT_MS,
        polling: 1000,
      })
      .catch(() => {
        out.runTimedOut = true;
      });

    // Transcript tail for triage.
    out.transcriptTail = (await page.locator(".chat-repl").innerText().catch(() => "")).slice(-1400);

    // Proposal staged?
    const applyBtn = page.locator('[data-testid="proposal-apply"]').last();
    out.staged = (await page.locator(".proposal-card").count()) > 0;
    out.visibleApply = (await applyBtn.count()) > 0 ? await applyBtn.isVisible() : false;

    if (out.staged && out.visibleApply) {
      await applyBtn.click();
      await page.waitForTimeout(800);
      // Applied when the card carries the applied status (or the design changed).
      out.applied = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".proposal-card")].pop();
        return !!card && card.className.includes("applied");
      });
    } else {
      out.applied = false;
    }

    // Capture the design the agent produced (dev getter).
    out.xml = await page.evaluate(() => (window.__airGetXml ? window.__airGetXml() : "")).catch(() => "");
    out.compCount = await page.evaluate(() => {
      const layer = document.querySelector(".svg-schematic-canvas .component-layer");
      return layer ? layer.childElementCount : 0;
    });

    // Simulate (only meaningful once a design is applied).
    if (out.applied) {
      const simBtn = page.locator('.toolbar button[title="Run Simulation"]');
      await simBtn.click();
      await page
        .waitForFunction(
          () => [...document.querySelectorAll(".log-entry")].some((e) => /Simulation (passed|failed)/.test(e.innerText)),
          null,
          { timeout: 90000, polling: 1000 },
        )
        .catch(() => {});
      out.simStatus = await page.evaluate(() => {
        const logs = [...document.querySelectorAll(".log-entry")].map((e) => e.innerText);
        if (logs.some((l) => /Simulation passed/.test(l))) return "passed";
        if (logs.some((l) => /Simulation failed/.test(l))) return "failed";
        if (logs.some((l) => /Simulation failed:/.test(l))) return "error";
        return "none";
      });
    } else {
      out.simStatus = "n/a";
    }

    // Firmware (MCU specs).
    if (spec.expectFirmware && out.applied) {
      await page.locator(".sidebar-tab").filter({ hasText: /^Firmware$/ }).click();
      await page.waitForTimeout(700);
      const fw = await page.evaluate(() => {
        const panel = document.querySelector(".firmware-panel, .detail-panel");
        if (!panel) return { present: false, text: "" };
        const text = panel.innerText || "";
        const empty = /Ask the AI to add an MCU|No firmware/i.test(text);
        const hasProject = /Target MCU|platformio|Generated source|micropython/i.test(text);
        return { present: hasProject && !empty, text: text.slice(0, 400) };
      });
      out.firmwarePresent = fw.present;
      out.firmwareText = fw.text;
    } else {
      out.firmwarePresent = false;
    }

    out.pageErrors = pageErrors;
    out.consoleErrors = consoleErrors;
    out.verdict = classify(spec, out);

    if (out.verdict.startsWith("bug") || out.verdict.startsWith("review")) {
      await page.screenshot({ path: `${OUT}/shots/${spec.id}.png` }).catch(() => {});
    }
    return out;
  } finally {
    await ctx.close();
  }
}

function classify(spec, o) {
  if (o.pageErrors && o.pageErrors.length) {
    o.bugDetail = "pageerror: " + o.pageErrors[0];
    return "bug:page-error";
  }
  if (!o.staged) {
    // The agent never staged a design. Could be a prompt/model limitation, a
    // budget/malformed stop, or the app silently failing. Flag for review.
    o.bugDetail = "no proposal staged; tail: " + (o.transcriptTail || "").slice(-300);
    return o.runTimedOut ? "agent-fail:timeout" : "agent-fail:no-stage";
  }
  if (o.staged && !o.visibleApply) {
    o.bugDetail = "proposal staged but Apply button not visible (render/CSS bug)";
    return "bug:no-visible-apply";
  }
  if (!o.applied) {
    o.bugDetail = "Apply clicked but design not marked applied";
    return "bug:apply-failed";
  }
  if (o.compCount === 0) {
    o.bugDetail = "applied but schematic component layer is empty";
    return "bug:blank-schematic";
  }
  if (spec.expectFirmware && !o.firmwarePresent) {
    o.bugDetail = "MCU spec applied but Firmware tab did not render a project";
    return "bug:firmware-missing";
  }
  if (spec.expectSimPass && o.simStatus !== "passed") {
    o.bugDetail = `expected sim pass but got ${o.simStatus}`;
    return "review:sim-fail";
  }
  if (o.consoleErrors && o.consoleErrors.length) {
    o.bugDetail = "console error: " + o.consoleErrors[0];
    return "review:console-error";
  }
  return "ok";
}

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      const v = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : "true";
      o[k] = v;
    }
  }
  return o;
}
