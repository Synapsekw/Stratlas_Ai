import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { privateNames } from './private-sources.mjs';
const browser = await chromium.launch({ headless: true });
const base = process.env.QUADRION_PREVIEW_URL || 'http://127.0.0.1:8766/landing-options/';
const pages = [
  'atlas',
  'confined-spaces',
  'corrosion',
  'roads',
  'volumetric',
  'facades',
  'evidence',
  'reporting',
];
const errors = [];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(r.status() + ' ' + r.url());
});
async function load(route) {
  await page.goto(base + route + '.html');
  await page.waitForFunction(
    () =>
      document.body.dataset.ready === 'true' ||
      window.atlasPreview?.getState().ready ||
      window.corrosionPreview?.getState().ready,
    {},
    { timeout: 25000 },
  );
}
async function layout() {
  const box = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(box.scroll <= box.width, JSON.stringify(box));
}
try {
  for (const route of pages) {
    await load(route);
    assert.match(await page.title(), /Quadrion AI/);
    assert.equal(await page.locator('.q-header').count(), 1);
    assert.equal(await page.locator('.q-footer').count(), 1);
    const text = await page.locator('body').innerText();
    assert.doesNotMatch(text, /stratlas/i);
    assert.deepEqual(privateNames(text), []);
    await page.evaluate(async () => {
      for (const i of document.images) i.loading = 'eager';
      await Promise.all([...document.images].map((i) => i.decode()));
    });
    await layout();
  }
  await load('atlas');
  let state = await page.evaluate(() => window.atlasPreview.getState());
  assert.equal(state.cloudReady, false);
  assert.equal(state.touring, false);
  for (let i = 0; i < 5; i++) {
    await page.locator(`[data-tour-step="${i}"]`).click();
    if (i === 1) await page.waitForFunction(() => window.atlasPreview.getState().cloudReady);
    state = await page.evaluate(() => window.atlasPreview.getState());
    assert.equal(state.tourStep, i);
    assert.equal(state.cloud, i === 1);
    assert.equal(state.video, i >= 2);
    assert.equal(state.projecting, i >= 3);
    assert.equal(state.view, i === 4 ? 'drone' : i >= 2 ? 'flight' : 'plant');
  }
  assert.equal(state.pointCount, 757579);
  await page.locator('.q-tour-reset').click();
  assert.equal((await page.evaluate(() => window.atlasPreview.getState())).tourStep, 0);
  await load('confined-spaces');
  await page.locator('[data-guide="interior"]').click();
  assert.equal(
    (await page.evaluate(() => window.inspectionPreview.getState())).scene.scanColour,
    'height',
  );
  await page.locator('[data-guide="flight"]').click();
  assert.equal(
    (await page.evaluate(() => window.inspectionPreview.getState())).scene.view,
    'drone',
  );
  await page.locator('[data-guide="finding"]').click();
  assert.equal((await page.evaluate(() => window.inspectionPreview.getState())).selected, 'F05');
  assert.equal(await page.locator('main .corrosion-teaser').count(), 0);
  await load('corrosion');
  assert.equal((await page.evaluate(() => window.corrosionPreview.getState())).view, 'whole');
  await page.locator('[data-guide="masks"]').click();
  assert.equal((await page.evaluate(() => window.corrosionPreview.getState())).view, 'detail');
  await page.locator('[data-guide="source"]').click();
  assert.equal((await page.evaluate(() => window.corrosionPreview.getState())).view, 'photo');
  await load('roads');
  await page.locator('[data-guide="defect"]').click();
  assert.equal((await page.evaluate(() => window.useCasePreview.getState())).type, 'potholes');
  await page.locator('[data-guide="condition"]').click();
  assert.equal((await page.evaluate(() => window.useCasePreview.getState())).assumption, 'high');
  await page.locator('.q-road-context').click();
  assert.ok(
    await page.locator('.road-photo img').evaluate((i) => i.complete && i.naturalWidth > 0),
  );
  await load('volumetric');
  const before = await page.evaluate(() => window.useCasePreview.getState());
  await page.locator('[data-epoch="e1"]').click();
  assert.equal((await page.evaluate(() => window.useCasePreview.getState())).epoch, 'e1');
  await page.locator('[data-guide="base"]').click();
  assert.equal((await page.evaluate(() => window.useCasePreview.getState())).base, 'plane');
  assert.notEqual((await page.evaluate(() => window.useCasePreview.getState())).net, before.net);
  await load('facades');
  await page.locator('[data-elevation="West elevation"]').click();
  assert.equal(await page.locator('[data-photo]:visible').count(), 2);
  await page.locator('[data-guide="thermal"]').click();
  assert.equal((await page.evaluate(() => window.useCasePreview.getState())).photo, 'p2736');
  await load('evidence');
  await page.locator('[data-guide="proof"]').click();
  await page.locator('.mark-reviewed').click();
  await page.locator('[data-guide="deliver"]').click();
  await load('reporting');
  assert.ok(
    (await page.evaluate(() => window.inspectionPreview.getState())).reviewed.includes('F05'),
  );
  const wait = page.waitForEvent('download');
  await page.locator('.download-csv').click();
  assert.equal((await wait).suggestedFilename(), 'quadrion-sample-findings.csv');
  const pdf = await page.request.get(base + 'quadrion-inspection-sample.pdf');
  assert.equal(pdf.status(), 200);
  assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers()['content-type'], /application\/pdf/);
  console.log(
    'Branding, all eight experiences, guided chapters, data controls and deliverables passed.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of pages) {
    await load(route);
    await layout();
    await page.locator('.q-menu-button').click();
    assert.equal(await page.locator('.q-menu-button').getAttribute('aria-expanded'), 'true');
    await page.locator('.q-use-cases summary').click();
    assert.equal(await page.locator('.q-use-cases a:visible').count(), 5);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.q-menu-button').getAttribute('aria-expanded'), 'false');
  }
  await page.goto(base + 'index.html');
  await page.waitForURL('**/atlas.html');
  assert.deepEqual(errors, []);
  const fallback = await browser.newPage({ reducedMotion: 'reduce' });
  await fallback.route('**/cloud.xyz', (r) => r.abort());
  await fallback.goto(base + 'atlas.html');
  await fallback.waitForFunction(() => window.atlasPreview?.getState().ready);
  await fallback.locator('[data-tour-step="1"]').click();
  await fallback.waitForFunction(() =>
    document.querySelector('.q-tour-caption span').textContent.includes('unavailable'),
  );
  assert.equal(await fallback.evaluate(() => window.atlasPreview.getState().ready), true);
  await fallback.locator('[data-tour-step="3"]').click();
  assert.equal(await fallback.evaluate(() => window.atlasPreview.getState().video), true);
  await fallback.close();
  console.log(
    'Mobile navigation, no overflow, reduced motion, canonical homepage and optional-cloud failure recovery passed.',
  );
} finally {
  await browser.close();
}
