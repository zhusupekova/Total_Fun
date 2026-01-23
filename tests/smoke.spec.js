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

test('score renders when provided', async ({ page }) => {
  await page.goto('/game');
  // inject mock score into page context
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'SCORE', payload: { score: { top: 1, right: 2, bottom: 3, left: 4 } } } }));
  });
  const scoreLine = page.locator('#score-line');
  await expect(scoreLine).toContainText('top:1');
});

test('match banner shows waiting', async ({ page }) => {
  await page.goto('/game');
  const banner = page.locator('#match-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Waiting');
});
