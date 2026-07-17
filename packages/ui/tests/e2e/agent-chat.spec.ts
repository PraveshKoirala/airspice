import { test, expect } from '@playwright/test';

test.describe('Agent Chat Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('verifies agent chat presence and toggle auto-apply', async ({ page }) => {
    // Basic check for chat panel
    const chatPanel = page.locator('.chat-repl');
    await expect(chatPanel).toBeVisible();

    // Auto apply toggle
    const toggle = page.getByTestId('auto-apply-toggle');
    await expect(toggle).toBeVisible();

    // Toggle the checkbox
    await toggle.check();
    await expect(toggle).toBeChecked();

    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();

    // Send button should be visible
    const sendBtn = page.getByTestId('agent-send');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toBeDisabled(); // Disabled when input is empty

    // Type in input
    const inputArea = page.locator('.chat-input-area textarea');
    await inputArea.fill('build a resistor network');
    await expect(sendBtn).toBeEnabled();
  });

  test('missing credentials are actionable and do not break the workspace', async ({ page }) => {
    // The app seeds local-proxy credentials at boot, so simulate a user who
    // cleared their key AFTER boot (no reload → no re-seed).
    await page.evaluate(() => {
      localStorage.removeItem('airspice.byok.openai');
    });
    const inputArea = page.locator('.chat-input-area textarea');
    await inputArea.fill('build a resistor network');
    await page.getByTestId('agent-send').click();

    await expect(page.getByText('No openai API key stored. Add one in Settings.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
    await expect(page.locator('.schematic-canvas')).toBeVisible();
  });

  test('boot seeds the local proxy credentials so chat works out of the box', async ({ page }) => {
    const seeded = await page.evaluate(() => ({
      key: localStorage.getItem('airspice.byok.openai'),
      base: localStorage.getItem('airspice.byok.openai.baseUrl'),
    }));
    expect(seeded.key).toBe('test-key-123');
    expect(seeded.base).toBe('http://localhost:8317/v1');
  });
});
