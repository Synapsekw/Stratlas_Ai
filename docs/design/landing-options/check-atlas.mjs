import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { privateNames } from './private-sources.mjs';
const require = createRequire(import.meta.url),
  sharp = require('sharp');
const output = fileURLToPath(new URL('../assets/fusion/', import.meta.url));
const flight = JSON.parse(await readFile(output + 'flight.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
const url = 'http://127.0.0.1:8766/landing-options/atlas.html';
const state = () => page.evaluate(() => window.atlasPreview.getState());
async function ready() {
  await page.waitForFunction(
    () => window.atlasPreview?.getState().ready,
    null,
    { timeout: 60000 },
  );
  await page.evaluate(() => document.fonts.ready);
}
async function top() {
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(200);
}
async function stable() {
  await page.waitForTimeout(1500);
}
async function projected() {
  await page.waitForFunction(
    () => {
      const s = window.atlasPreview.getState();
      return (
        s.projectorEnabled &&
        s.occlusion === 1 &&
        !document.querySelector('.atlas-video-source').seeking
      );
    },
    null,
    { timeout: 15000 },
  );
}
async function layout() {
  const data = await page.evaluate(() => ({
    w: innerWidth,
    scroll: document.documentElement.scrollWidth,
    text: document.body.innerText,
    dark: getComputedStyle(document.body).colorScheme,
  }));
  assert.ok(data.scroll <= data.w, `Overflow ${data.scroll}/${data.w}`);
  assert.equal(data.dark, 'dark');
  assert.deepEqual(privateNames(data.text), [], 'Customer identity in visible copy');
}
try {
  await page.goto(url);
  await ready();
  await top();
  await layout();
  let s = await state();
  assert.equal(s.rotating, true);
  assert.equal(s.video, false);
  assert.equal(s.cloud, false);
  assert.equal(s.pointCount, 757579);
  assert.equal(s.sourceTriangleCount, s.renderTriangleCount);
  assert.equal(s.receiverCount, 5);
  const before = s.camera;
  await page.waitForTimeout(500);
  assert.notDeepEqual(
    (await state()).camera,
    before,
    'The plant should rotate on arrival',
  );
  await page.locator('.atlas-rotation').click();
  assert.equal((await state()).rotating, false);
  await stable();
  await page.screenshot({ path: output + 'atlas-dark-desktop.png' });
  await page.locator('#atlas-cloud').focus();
  await page.keyboard.press('Space');
  assert.equal((await state()).cloudVisible, true);
  assert.equal(await page.locator('.atlas-height-legend').isVisible(), true);
  assert.equal(await page.locator('.height-min').innerText(), '-12 m');
  assert.equal(await page.locator('.height-max').innerText(), '76 m');
  await stable();
  await page.screenshot({ path: output + 'atlas-height-desktop.png' });
  await page.locator('#atlas-video').check();
  await projected();
  await stable();
  assert.equal((await state()).cloudVisible, true);
  assert.equal((await state()).video, true);
  assert.equal((await state()).playing, true);
  assert.equal((await state()).cloudOpacity, 0.42);
  await page
    .getByRole('button', { name: 'Pause drone flight', exact: true })
    .click();
  await page.locator('#atlas-cloud').uncheck();
  await page.locator('.atlas-seek').fill('3');
  await projected();
  await stable();
  s = await state();
  const expected = flight.samples.find((p) => p.t === 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(s.dronePosition[i] - expected.pos[i]) < 0.00001);
    assert.ok(Math.abs(s.projectorPosition[i] - expected.pos[i]) < 0.00001);
  }
  assert.equal(s.patchedMaterials, 5);
  assert.equal(s.droneVisible, true);
  await top();
  await page.screenshot({ path: output + 'atlas-projected-desktop.png' });
  const withProjection = await sharp(
    await page.locator('.atlas-canvas').screenshot(),
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  const projectionCamera = (await state()).camera;
  await page.locator('#atlas-video').uncheck();
  await page.waitForTimeout(400);
  assert.equal((await state()).projectorEnabled, false);
  assert.equal((await state()).playing, false);
  const withoutProjection = await sharp(
    await page.locator('.atlas-canvas').screenshot(),
  )
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual(withProjection.info, withoutProjection.info);
  let changed = 0;
  for (
    let i = 0;
    i < withProjection.data.length;
    i += withProjection.info.channels
  ) {
    if (
      Math.abs(withProjection.data[i] - withoutProjection.data[i]) +
        Math.abs(withProjection.data[i + 1] - withoutProjection.data[i + 1]) +
        Math.abs(withProjection.data[i + 2] - withoutProjection.data[i + 2]) >
      60
    )
      changed++;
  }
  assert.ok(
    changed > 5000,
    `Expected actual projection in the WebGL canvas, changed ${changed} pixels`,
  );
  assert.ok(
    (await state()).camera.every(
      (n, i) => Math.abs(n - projectionCamera[i]) < 0.01,
    ),
    'Disabling video preserves the viewpoint',
  );
  await page.locator('#atlas-video').check();
  await projected();
  await page
    .getByRole('button', { name: 'Pause drone flight', exact: true })
    .click();
  await page.locator('.atlas-seek').fill('3');
  await projected();
  await page.locator('.atlas-drone-eye').click();
  await projected();
  s = await state();
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(s.camera[i] - expected.pos[i]) < 0.00001);
  for (let i = 0; i < 4; i++)
    assert.ok(Math.abs(s.cameraQuaternion[i] - expected.q[i]) < 0.00001);
  assert.equal(s.droneVisible, false);
  await top();
  await page.screenshot({ path: output + 'atlas-drone-eye-desktop.png' });
  await page.locator('.atlas-flight-view').click();
  await stable();
  const t = (await state()).time;
  await page
    .getByRole('button', { name: 'Play drone flight', exact: true })
    .click();
  await page.waitForTimeout(400);
  await page
    .getByRole('button', { name: 'Pause drone flight', exact: true })
    .click();
  assert.ok((await state()).time > t + 0.1);
  await page.locator('.site-header [data-product]').click();
  assert.equal(await page.locator('dialog').evaluate((d) => d.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate((d) => d.open), false);
  await page.locator('.atlas-reset').click();
  await stable();
  s = await state();
  assert.equal(s.view, 'plant');
  assert.equal(s.cloud, false);
  assert.equal(s.video, false);
  assert.equal(s.rotating, true);
  await page.locator('.atlas-rotation').click();
  const box = await page.locator('.atlas-canvas').boundingBox(),
    dragBefore = (await state()).camera;
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.53, box.y + box.height * 0.53, {
    steps: 8,
  });
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.notDeepEqual((await state()).camera, dragBefore);
  console.log(
    'Atlas desktop passed: dark theme, rotation, original geometry, measured height cloud, combined layers, visible surface projection, occlusion, recorded poses, seeking, playback and orbit.',
  );
  for (const width of [900, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(url);
    await ready();
    await layout();
    await top();
    if (width === 390) {
      await page.screenshot({ path: output + 'atlas-dark-mobile.png' });
      await page.locator('#atlas-cloud').check();
      assert.equal((await state()).cloud, true);
      await page.locator('#atlas-video').check();
      await page.locator('.atlas-scene').scrollIntoViewIfNeeded();
      await projected();
      await stable();
      await page.screenshot({ path: output + 'atlas-projected-mobile.png' });
      await layout();
      await page.locator('.atlas-flight-panel').scrollIntoViewIfNeeded();
      assert.equal(
        await page.locator('.atlas-flight-actions').isVisible(),
        true,
      );
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await ready();
  await top();
  assert.equal((await state()).rotating, false);
  assert.equal((await state()).playing, false);
  const still = (await state()).camera;
  await page.waitForTimeout(400);
  assert.deepEqual((await state()).camera, still);
  await page.locator('.atlas-launch').click();
  await projected();
  assert.equal((await state()).video, true);
  await page.locator('#atlas-video').uncheck();
  assert.equal((await state()).video, false);
  await page.locator('.inspection-pages').scrollIntoViewIfNeeded();
  await layout();
  assert.equal(await page.locator('.inspection-pages a').count(), 4);
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map(async (i) => {
        i.loading = 'eager';
        await i.decode();
      }),
    );
  });
  assert.deepEqual(errors, []);
  console.log(
    'Atlas tablet/mobile passed: layout, layer controls, explicit playback with reduced motion, product links and image loading. No browser or HTTP errors.',
  );
} finally {
  await browser.close();
}
