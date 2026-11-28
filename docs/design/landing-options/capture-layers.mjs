import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../assets/fusion/', import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
  });
  await page.goto('http://127.0.0.1:8766/landing-options/');
  await page.waitForFunction(() => window.fusionPreview?.getState().ready);
  await page.locator('.timeline-input').fill('3');
  await page.addStyleTag({
    content:
      '.hero-copy,.hero-side,.scene-shade,.scene-coordinate,.scene-label,.wipe-control,.load-status,.site-header,.experience-console,.hero-foot,.direction-switch{visibility:hidden!important}',
  });
  for (const mode of ['cloud', 'model']) {
    await page.locator(`[data-mode=${mode}]`).evaluate((e) => e.click());
    await page.waitForTimeout(250);
    await page
      .locator('.spatial-canvas')
      .screenshot({ path: output + mode + '-preview.jpg', type: 'jpeg', quality: 90 });
  }
  console.log('Captured clean views directly from the live renderer.');
} finally {
  await browser.close();
}
