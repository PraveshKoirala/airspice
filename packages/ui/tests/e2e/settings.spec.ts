import { test, expect } from '@playwright/test';

test.describe('Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/project');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
  });

  test('can open settings and interact with provider and model', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.settings-panel')).toBeVisible();

    const providerPicker = page.getByTestId('provider-picker');
    await expect(providerPicker).toBeVisible();
    await expect(providerPicker).toHaveValue('openai');

    const modelPicker = page.getByTestId('model-picker');
    await expect(modelPicker).toHaveValue('claude-sonnet-4-6');
    await expect(page.getByTestId('model-override')).toHaveValue('');

    await providerPicker.selectOption('gemini');

    await expect(modelPicker).toBeVisible();
    
    const overrideInput = page.getByTestId('model-override');
    await overrideInput.fill('custom-model-id');
    await expect(modelPicker).toBeDisabled();
    
    await overrideInput.fill('');
    await expect(modelPicker).toBeEnabled();
  });

  test('can save and clear API keys', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    
    const keyInput = page.getByTestId('key-input');
    const saveButton = page.getByTestId('save-key');
    const clearButton = page.getByTestId('clear-key');
    
    // Ensure clean state even if something injected a key
    if (await clearButton.isEnabled()) {
      await clearButton.click();
    }
    
    await expect(clearButton).toBeDisabled();
    
    await keyInput.fill('test-api-key');
    await saveButton.click();
    
    await expect(page.getByTestId('stored-mask')).toBeVisible();
    await expect(clearButton).toBeEnabled();
    
    await clearButton.click();
    await expect(page.getByTestId('stored-mask')).not.toBeVisible();
  });

  test('migrates the invalid legacy default model', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('airspice.agent.settings', JSON.stringify({
        state: {
          agentProvider: 'openai',
          agentModel: 'gemini-3.5-flash-high',
          freeTextModel: 'gemini-3.5-flash-high',
          autoApply: false,
          malformedCount: 0,
        },
        version: 0,
      }));
    });
    await page.reload();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    await expect(page.getByTestId('provider-picker')).toHaveValue('openai');
    await expect(page.getByTestId('model-picker')).toHaveValue('claude-sonnet-4-6');
    await expect(page.getByTestId('model-override')).toHaveValue('');
  });
});
