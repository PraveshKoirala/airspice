// Screenshot harness for visual QA against a RUNNING dev server (vite dev).
//
//   node scripts/screenshot.mjs <outDir> [xmlFile] [tab] [theme]
//
//   xmlFile  optional design to load via the DEV-only window.__airSetXml hook
//            (designStore.ts) — no Monaco interaction needed.
//   tab      sidebar tab to open (default "Schematic").
//   theme    "light" to toggle from the default dark theme.
//   PORT     env var overrides the dev-server port (default 5199).
//
// Saves full.png (viewport) and, on the Schematic tab, schematic.png (canvas).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.argv[2] ?? '.');
const xmlFile = process.argv[3];
const tab = process.argv[4] || 'Schematic';
const theme = process.argv[5] ?? 'dark';
const BASE = `http://localhost:${process.env.PORT ?? '5199'}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(BASE + '/project', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="schematic-svg"]', { timeout: 20000 });

if (xmlFile) {
  const xml = readFileSync(xmlFile, 'utf8');
  await page.waitForFunction(() => typeof window.__airSetXml === 'function');
  await page.evaluate((x) => window.__airSetXml(x), xml);
  await page.waitForTimeout(1500);
}
if (theme === 'light') {
  await page.locator('.theme-toggle').click();
  await page.waitForTimeout(400);
}
if (tab !== 'Schematic') {
  await page.getByRole('button', { name: tab }).click();
  await page.waitForTimeout(800);
}

await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/full.png` });
const canvas = page.locator('.svg-schematic-canvas');
if (tab === 'Schematic' && await canvas.count()) {
  await canvas.screenshot({ path: `${outDir}/schematic.png` });
}
await browser.close();
console.log('saved to', outDir);
