// @ts-check
import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:3000/game';

export default defineConfig({
  testDir: './tests',
  retries: 0,
  use: {
    headless: true,
    baseURL,
  },
  timeout: 30_000,
});
