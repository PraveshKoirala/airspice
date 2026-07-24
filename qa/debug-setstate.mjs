// One-shot debugger: capture the JS stack behind the React
// "setState while rendering" warning by wrapping console.error in-page.
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5199";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

await page.addInitScript(() => {
  const orig = console.error;
  window.__warnStacks = [];
  console.error = (...args) => {
    const msg = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    if (/while rendering a different component|setState/.test(msg)) {
      window.__warnStacks.push({ msg: msg.slice(0, 200), stack: new Error().stack });
    }
    return orig.apply(console, args);
  };
});

await page.goto(`${BASE}/project`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="schematic-svg"]', { timeout: 20000 });
await page.waitForTimeout(1500);

// Drive a real (fast) agent build so the full chat flow runs.
await page.locator(".chat-input-area textarea").fill(
  "Build a resistor divider: a 5V source, two 1k resistors in series to ground, probe the midpoint.",
);
await page.locator('[data-testid="agent-send"]').click();
await page.waitForTimeout(1500);
await page
  .waitForFunction(() => !document.querySelector(".message.loading"), null, { timeout: 180000, polling: 1000 })
  .catch(() => {});
// Apply if staged.
const apply = page.locator('[data-testid="proposal-apply"]').last();
if ((await apply.count()) && (await apply.isVisible())) {
  await apply.click();
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(500);

const stacks = await page.evaluate(() => window.__warnStacks || []);
console.log("captured", stacks.length, "warning(s)");
for (const s of stacks.slice(0, 3)) {
  console.log("\n=== MSG:", s.msg);
  console.log(s.stack.split("\n").slice(0, 14).join("\n"));
}
await browser.close();
