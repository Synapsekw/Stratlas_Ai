import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output = new URL('../../../.superpowers/scene-verification/', import.meta.url);
await mkdir(output, { recursive: true });

const base = process.env.QUADRION_PREVIEW_URL || 'http://127.0.0.1:8766/landing-options/';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce',
});
const errors = [];
const failures = [];
page.on('pageerror', (error) => errors.push(error.message));
const state = () => page.evaluate(() => window.atlasPreview.getState());
const chapter = (index) => page.locator(`[data-tour-step="${index}"]`).click();
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.error('FAIL ' + name + ': ' + error.message);
  }
}
async function settle() {
  await page.waitForFunction(() => {
    const s = window.atlasPreview.getState();
    return !s.cameraTransition && !s.layerTransition;
  });
}
try {
  await page.goto(base + 'atlas.html');
  await page.waitForFunction(() => window.atlasPreview?.getState().ready, null, { timeout: 60000 });
  await chapter(1);
  await page.waitForFunction(() => window.atlasPreview.getState().cloudReady);
  await chapter(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await check('cloud reveals gradually and reaches full opacity', async () => {
    const initial = await page.evaluate(() => {
      document.querySelector('[data-tour-step="1"]').click();
      return window.atlasPreview.getState().cloudOpacity;
    });
    assert.ok(initial < 0.05, 'cloud appeared immediately at opacity ' + initial);
    await page.waitForFunction(() => {
      const opacity = window.atlasPreview.getState().cloudOpacity;
      return opacity > 0.1 && opacity < 0.9;
    });
    await page.waitForFunction(() => window.atlasPreview.getState().cloudOpacity === 1);
  });
  await chapter(0);
  await settle();

  await check('scene uses every available animation frame', async () => {
    const sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          let ticks = 0;
          const before = window.atlasPreview.getState().frames;
          function frame() {
            if (++ticks < 60) requestAnimationFrame(frame);
            else resolve({ ticks, rendered: window.atlasPreview.getState().frames - before });
          }
          requestAnimationFrame(frame);
        }),
    );
    assert.ok(sample.rendered >= sample.ticks * 0.9, JSON.stringify(sample));
    console.log('Render cadence: ' + JSON.stringify(sample));
  });

  await chapter(4);
  await settle();
  await page.locator('.atlas-video-source').evaluate((video) => video.pause());
  await check('returning from drone view preserves orientation at the handoff', async () => {
    const sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const before = window.atlasPreview.getState().cameraQuaternion;
          document.querySelector('[data-tour-step="2"]').click();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const after = window.atlasPreview.getState().cameraQuaternion;
              const dot = Math.abs(before.reduce((sum, value, i) => sum + value * after[i], 0));
              resolve(2 * Math.acos(Math.min(1, dot)));
            }),
          );
        }),
    );
    assert.ok(sample < 0.12, 'camera jumped ' + sample.toFixed(3) + ' radians');
    console.log('Drone exit angle: ' + sample.toFixed(4) + ' radians');
  });
  await settle();

  await check('grabbing the canvas during a camera move preserves orientation', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await chapter(4);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await chapter(2);
    await page.waitForTimeout(700);
    const canvas = await page.locator('.atlas-canvas canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
    const before = (await state()).cameraQuaternion;
    await page.mouse.down();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = (await state()).cameraQuaternion;
    await page.mouse.up();
    const dot = Math.abs(before.reduce((sum, value, i) => sum + value * after[i], 0));
    const angle = 2 * Math.acos(Math.min(1, dot));
    assert.ok(angle < 0.08, 'grabbing the camera jumped ' + angle.toFixed(3) + ' radians');
    assert.equal((await state()).cameraTransition, false);
  });

  await check('projected footage fades in', async () => {
    await chapter(2);
    await settle();
    const initial = await page.evaluate(() => {
      document.querySelector('[data-tour-step="3"]').click();
      return window.atlasPreview.getState().projectionOpacity;
    });
    assert.ok(initial < 0.05, 'projection appeared immediately: ' + initial);
    await page.waitForFunction(() => {
      const opacity = window.atlasPreview.getState().projectionOpacity;
      return opacity > 0.1 && opacity < 0.8;
    });
    await page.waitForFunction(() => window.atlasPreview.getState().projectionOpacity > 0.96);
    await page.screenshot({ path: fileURLToPath(new URL('desktop.png', output)) });
  });

  await check('flight overview restores the view after manual orbit', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.atlas-flight-view').click();
    const before = (await state()).camera;
    const canvas = await page.locator('.atlas-canvas canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.5, {
      steps: 8,
    });
    await page.mouse.up();
    assert.notDeepEqual((await state()).camera, before);
    await page.locator('.atlas-flight-view').click();
    const after = (await state()).camera;
    assert.ok(Math.hypot(...before.map((value, i) => value - after[i])) < 0.01);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await check('rapid chapter changes finish in the latest scene', async () => {
    for (const index of [4, 1, 3, 0, 4, 2]) await chapter(index);
    await settle();
    const s = await state();
    assert.equal(s.view, 'flight');
    assert.equal(s.tourStep, 2);
    assert.equal(s.cloudVisible, false);
    assert.equal(s.projectorEnabled, false);
    assert.equal(s.cameraTransition, false);
    assert.equal(s.layerTransition, false);
  });

  await check('reduced motion completes an in-flight transition immediately', async () => {
    await chapter(4);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !window.atlasPreview.getState().cameraTransition);
    const s = await state();
    assert.equal(s.touring, false);
    assert.equal(s.rotating, false);
    assert.equal(s.cameraTransition, false);
    assert.equal(s.layerTransition, false);
    assert.equal(s.playing, false);
    await chapter(1);
    assert.equal((await state()).cloudOpacity, 1);
  });

  await check('mobile chapter navigation fits the viewport', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const index of [0, 1, 2, 3, 4, 0]) await chapter(index);
    assert.equal((await state()).tourStep, 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: fileURLToPath(new URL('mobile.png', output)) });
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, [], failures.join('\n'));
} finally {
  await browser.close();
}
