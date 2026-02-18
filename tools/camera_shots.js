import { chromium } from '@playwright/test';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith('--')) return fallback;
  return v;
}

const baseUrl = argValue('--base', process.env.CAM_BASE || 'http://localhost:3000');
const wsUrl = argValue('--ws', process.env.CAM_WS || 'ws://localhost:7071');
const outDir = argValue('--out', process.env.CAM_OUT || 'test-results/cam');

const presets = [
  { name: 'default', q: {} },
  { name: 'a_7.2_10_42_-1.6', q: { camY: 7.2, camZ: 10, camFov: 42, camLookZ: -1.6 } },
  { name: 'b_7.8_10.8_40_-1.9', q: { camY: 7.8, camZ: 10.8, camFov: 40, camLookZ: -1.9 } },
  { name: 'c_6.8_9.6_44_-1.4', q: { camY: 6.8, camZ: 9.6, camFov: 44, camLookZ: -1.4 } },
  { name: 'd_7.2_9.2_44_-1.6', q: { camY: 7.2, camZ: 9.2, camFov: 44, camLookZ: -1.6 } },
  { name: 'e_7.8_9.0_42_-1.8', q: { camY: 7.8, camZ: 9.0, camFov: 42, camLookZ: -1.8 } },
  { name: 'f_8.4_9.2_40_-2.0', q: { camY: 8.4, camZ: 9.2, camFov: 40, camLookZ: -2.0 } },
  { name: 'g_7.6_8.4_44_-1.5', q: { camY: 7.6, camZ: 8.4, camFov: 44, camLookZ: -1.5 } },
  { name: 'h_8.2_8.6_42_-1.7', q: { camY: 8.2, camZ: 8.6, camFov: 42, camLookZ: -1.7 } },
];

const viewports = [
  { name: 'desktop_1280x720', width: 1280, height: 720 },
  { name: 'tablet_1024x768', width: 1024, height: 768 },
  { name: 'phone_812x375', width: 812, height: 375 },
];

function buildUrl(preset) {
  const u = new URL('/game', baseUrl);
  u.searchParams.set('ws', wsUrl);
  // Keep debug off for clean framing; we hide overlays via CSS anyway.
  u.searchParams.set('debug', '0');
  Object.entries(preset.q || {}).forEach(([k, v]) => {
    u.searchParams.set(k, String(v));
  });
  return u.toString();
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Make sure output directory exists.
  // eslint-disable-next-line no-console
  console.log(`[cam] base=${baseUrl} ws=${wsUrl} out=${outDir}`);

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const preset of presets) {
      const url = buildUrl(preset);
      // eslint-disable-next-line no-console
      console.log(`[cam] ${vp.name} ${preset.name} -> ${url}`);
      const arenaWait = page.waitForResponse((resp) => {
        try {
          return resp.url().includes('/assets/arena.glb') && resp.status() === 200;
        } catch {
          return false;
        }
      }, { timeout: 30000 }).catch(() => null);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await arenaWait;

      // Hide UX/debug overlays that would obstruct the arena in screenshots.
      await page.addStyleTag({
        content: `
          #investor-overlay, #hud, #net-panel, #control-hint, #invite-overlay, #finish-overlay, #cta-retry, #error-banner { display: none !important; }
          #touch-controls { opacity: 0 !important; }
        `,
      });

      // Give the GLTF loaders + parse time (arena.glb is large) + first render a moment.
      await page.waitForTimeout(6500);

      const path = `${outDir}/${vp.name}__${preset.name}.png`;
      await page.screenshot({ path, fullPage: true });
    }
  }

  await browser.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
