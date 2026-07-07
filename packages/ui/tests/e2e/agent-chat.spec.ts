import { test, expect } from '@playwright/test';

test.describe('Agent Chat Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
  });

  test('verifies agent chat presence', async ({ page }) => {
    // Basic check for chat panel
    const chatPanel = page.locator('.chat-repl');
    await expect(chatPanel).toBeVisible();
    
    // Send button should be visible
    const sendBtn = page.locator('[data-testid="agent-send"]');
    await expect(sendBtn).toBeVisible();
  });
});
