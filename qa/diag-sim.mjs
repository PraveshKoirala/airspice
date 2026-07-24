// Replay a captured design's XML and dump its simulation report + diagnostics.
// Read-only against the running dev server; uses the dev hook, no agent/proxy.
//   node qa/diag-sim.mjs <id> [<id> ...]
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";

const ids = process.argv.slice(2);
const rows = readFileSync("qa/circuit-corpus/results/results.jsonl", "utf8")
  .trim().split("\n").map((l) => JSON.parse(l));
const BASE = "http://localhost:5199";

const browser = await chromium.launch();
for (const id of ids) {
  const row = rows.find((r) => r.id === id);
  if (!row || !row.xml) { console.log(`\n### ${id}: no captured xml`); continue; }
  const page = await browser.newPage();
  try {
    await page.goto(`${BASE}/project`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="schematic-svg"]', { timeout: 20000 });
    await page.waitForFunction(() => typeof window.__airSetXml === "function");
    await page.evaluate((x) => window.__airSetXml(x), row.xml);
    await page.waitForTimeout(500);
    await page.locator('.toolbar button[title="Run Simulation"]').click();
    await page.waitForFunction(
      () => [...document.querySelectorAll(".log-entry")].some((e) => /Simulation (passed|failed)/.test(e.innerText)),
      null, { timeout: 60000, polling: 800 },
    ).catch(() => {});
    await page.waitForTimeout(400);
    const report = await page.evaluate(() => {
      const p = document.querySelector(".detail-panel");
      return p ? p.innerText.slice(0, 1400) : "(no panel)";
    });
    console.log(`\n############### ${id} (${row.mcu || "analog"}) ###############`);
    console.log(report);
  } catch (e) {
    console.log(`\n### ${id}: ${e.message}`);
  } finally {
    await page.close();
  }
}
await browser.close();
