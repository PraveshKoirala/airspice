import { test, expect } from '@playwright/test';

test.describe('Sidebar and Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('creates a new blank project', async ({ page }) => {
    await page.locator('.sidebar-create-btn').click();
    await page.getByText('Blank Project').click();
    await expect(page.locator('.sidebar-tab.active')).toHaveText('Schematic');
    await expect(page.locator('.project-list-item:has-text("Blank Project")').first()).toBeVisible();
  });

  test('direct workspace cold start loads existing projects before creating a default', async ({ page }) => {
    await page.goto('/tests/browser/harness/index.html');
    await page.waitForFunction(() => window.__storage !== undefined);
    await page.evaluate(async () => {
      await window.__storage.useProjectStore.getState().init();
      await window.__storage.useProjectStore.getState().createProject('Existing Project', '<system name="existing"/>');
    });

    await page.goto('/project');
    await expect(page.getByRole('heading', { name: 'Existing Project', exact: true })).toBeVisible();
    await expect(page.getByText('Untitled Project', { exact: true })).toHaveCount(0);
  });

  test('can switch between all tabs', async ({ page }) => {
    await page.locator('.sidebar-create-btn').click();
    await page.getByText('Blank Project').click();

    // Artifacts is server-mode only; the e2e server runs the local engine.
    const tabs = ['Schematic', 'AIR XML', 'Simulation', 'Firmware', 'Validation', 'Repair', 'Settings'];
    for (const tabName of tabs) {
      // Find the sidebar tab containing the exact text
      await page.locator('.sidebar-tab').filter({ hasText: new RegExp('^' + tabName + '$') }).click();
      await expect(page.locator('.sidebar-tab.active')).toHaveText(tabName);
    }
  });

  test('can rename a project', async ({ page }) => {
    await page.locator('.sidebar-create-btn').click();
    await page.getByText('Blank Project').click();

    page.on('dialog', dialog => dialog.accept('Renamed Project'));
    await page.locator('.project-list-item:has-text("Blank Project") .project-action-btn[title="Rename"]').first().click();
    await expect(page.locator('.project-list-item:has-text("Renamed Project")').first()).toBeVisible();
  });

  test('can duplicate a project', async ({ page }) => {
    await page.locator('.sidebar-create-btn').click();
    await page.getByText('Blank Project').click();

    await page.locator('.project-list-item:has-text("Blank Project") .project-action-btn[title="Duplicate"]').first().click();
    await expect(page.locator('.project-list-item:has-text("Blank Project (Copy)")').first()).toBeVisible();
  });

  test('can delete a project and undo', async ({ page }) => {
    await page.locator('.sidebar-create-btn').click();
    await page.getByText('Voltage Divider Template').click();
    
    await expect(page.locator('.project-list-item:has-text("Voltage Divider")').first()).toBeVisible();
    await page.locator('.project-list-item:has-text("Voltage Divider") .project-action-btn[title="Delete"]').first().click();
    await expect(page.locator('.project-list-item:has-text("Voltage Divider")').first()).not.toBeVisible();
    
    const undoButton = page.getByRole('button', { name: 'Undo' });
    await expect(undoButton).toBeVisible();
    await undoButton.click();
    await expect(page.locator('.project-list-item:has-text("Voltage Divider")').first()).toBeVisible();
  });

  test('can toggle theme', async ({ page }) => {
    const themeToggle = page.locator('.theme-toggle');
    await expect(themeToggle).toBeVisible();
    const modeText = await themeToggle.innerText();
    await themeToggle.click();
    await expect(themeToggle).not.toHaveText(modeText);
  });
});
