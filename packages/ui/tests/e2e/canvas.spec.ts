import { test, expect } from '@playwright/test';

test.describe('Canvas Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('renders schematic canvas', async ({ page }) => {
    await expect(page.getByTestId('schematic-svg')).toBeVisible();
    await expect(page.locator('.schematic-canvas')).toBeVisible();
  });

  test('can see components in palette', async ({ page }) => {
    const palette = page.getByTestId('schematic-palette');
    await expect(palette).toBeVisible();
    
    const list = page.getByTestId('palette-list');
    await expect(list).toBeVisible();
    
    // There should be some items in the palette
    const items = list.locator('.palette-item');
    await expect(items.first()).toBeVisible();
  });

  test('can search components in palette', async ({ page }) => {
    const search = page.getByTestId('palette-search');
    await search.fill('resistor');
    
    const items = page.getByTestId('palette-list').locator('.palette-item');
    // Ensure that it filters (or at least doesn't crash)
    await expect(items.first()).toBeVisible();
  });
});
