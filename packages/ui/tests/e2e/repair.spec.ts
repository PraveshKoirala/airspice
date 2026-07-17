import { test, expect } from '@playwright/test';

test.describe('Repair Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('can open repair panel and see run button', async ({ page }) => {
    // Open repair tab
    await page.locator('.sidebar-tab').filter({ hasText: /^Repair$/ }).click();
    await expect(page.getByTestId('repair-panel')).toBeVisible();

    const runButton = page.getByTestId('repair-run');
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeEnabled();
  });

  test('missing credentials produce an actionable outcome', async ({ page }) => {
    // The app seeds local-proxy credentials at boot; simulate a user who
    // cleared their key AFTER boot (no reload → no re-seed).
    await page.evaluate(() => {
      localStorage.removeItem('airspice.byok.openai');
    });
    await page.locator('.sidebar-tab').filter({ hasText: /^Repair$/ }).click();

    await expect(page.getByTestId('repair-run')).toBeVisible();

    await page.getByTestId('repair-run').click();

    const outcome = page.getByTestId('repair-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute('data-reason', 'provider_error');
    await expect(outcome).toContainText('No openai API key stored. Add one in Settings.');
    await expect(page.getByTestId('repair-run')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
  });
});
