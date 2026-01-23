import { test, expect } from '@playwright/test';

test('game page loads and renders canvas', async ({ page }) => {
  await page.goto('/game');
  await page.waitForTimeout(500); // allow dynamic import
  const canvas = page.locator('#app canvas');
  await expect(canvas).toBeVisible();
  const hud = page.locator('#hud');
  await expect(hud).toBeVisible();
});

test('net panel hidden by default', async ({ page }) => {
  await page.goto('/game');
  const netPanel = page.locator('#net-panel');
  await expect(netPanel).toBeHidden();
});

test('net panel visible with debug flag', async ({ page }) => {
  await page.goto('/game?debug=1');
  const netPanel = page.locator('#net-panel');
  await expect(netPanel).toBeVisible();
});
