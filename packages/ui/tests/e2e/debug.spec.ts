import { test } from '@playwright/test';
import * as fs from 'fs';

test('dump page content', async ({ page }) => {
  await page.goto('/project');
  const content = await page.content();
  fs.writeFileSync('page-dump.html', content);
});
