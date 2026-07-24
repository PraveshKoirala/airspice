import { test, expect } from '@playwright/test';

test.describe('Toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('has all toolbar buttons visible', async ({ page }) => {
    const toolbar = page.locator('.toolbar');
    await expect(toolbar).toBeVisible();

    await expect(page.locator('.toolbar button[title="Save Design"]')).toBeVisible();
    await expect(page.locator('.toolbar button[title="Run Validation"]')).toBeVisible();
    await expect(page.locator('.toolbar button[title="Run Simulation"]')).toBeVisible();
    await expect(page.locator('.toolbar button[title="Auto Repair"]')).toBeVisible();
  });
});
