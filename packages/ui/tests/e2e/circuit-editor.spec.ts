import { test, expect } from '@playwright/test';

test.describe('Circuit Editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
  });

  test('can see schematic palette and components', async ({ page }) => {
    // Check if the schematic palette is rendered
    const palette = page.locator('[data-testid="schematic-palette"]');
    await expect(palette).toBeVisible();
    
    // Check if the search input is visible
    const search = page.locator('[data-testid="palette-search"]');
    await expect(search).toBeVisible();
    
    // There should be items in the palette list
    const list = page.locator('[data-testid="palette-list"]');
    await expect(list).toBeVisible();
  });
});
