import { test, expect } from '@playwright/test';

test.describe('Simulation Tabs', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('can open simulation tab and see output panels', async ({ page }) => {
    await expect(page.getByTestId('engine-mode')).toHaveText('Local engine');
    await page.locator('.sidebar-tab').filter({ hasText: /^Simulation$/ }).click();
    await expect(page.locator('.sidebar-tab.active')).toHaveText('Simulation');
    
    const resultPanel = page.locator('.result-panel');
    await expect(resultPanel).toBeVisible();
    
    // Waveform viewer or empty state should be visible
    const hasWaveform = await page.locator('.waveform-viewer').isVisible();
    if (!hasWaveform) {
      // Look for the "No simulation run yet" EmptyState
      await expect(page.locator('.empty-state-title', { hasText: 'No simulation run yet' }).or(page.getByText('No simulation run yet'))).toBeVisible();
    }
    
    await page.locator('.toolbar button[title="Run Simulation"]').click();
    
    // We should see a log entry in the result panel (Simulation passed/failed)
    await expect(page.locator('.log-entry').first()).toBeVisible({ timeout: 15000 });
  });
});
