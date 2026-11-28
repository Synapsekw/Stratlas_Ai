import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { privateNames } from './private-sources.mjs';
const output = fileURLToPath(new URL('../assets/fusion/', import.meta.url));
const flight = JSON.parse(await readFile(output + 'flight.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
const results = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
async function load(file) {
  await page.goto(`http://127.0.0.1:8766/landing-options/${file}`);
  await page.waitForFunction(() => window.fusionPreview?.getState().ready, null, {
    timeout: 30000,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map(async (i) => {
        i.loading = 'eager';
        await i.decode();
      }),
    );
  });
  if (await page.getByRole('button', { name: 'Pause flight', exact: true }).count())
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
}
async function state() {
  return page.evaluate(() => window.fusionPreview.getState());
}
async function layout() {
  const info = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    text: document.body.innerText,
    broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src),
  }));
  assert.ok(info.scroll <= info.width, `Horizontal overflow: ${info.scroll} > ${info.width}`);
  assert.deepEqual(info.broken, []);
  assert.deepEqual(privateNames(info.text), [], 'Customer name in visible copy');
}
try {
  for (const [file, name] of [
    ['index.html', 'reality'],
  ]) {
    await page.setViewportSize({ width: 1440, height: 960 });
    await load(file);
    await layout();
    await page.locator('.timeline-input').fill('3');
    await page.waitForTimeout(200);
    await page.screenshot({ path: output + name + '-desktop.png' });
    await page.getByRole('button', { name: 'Drone eye', exact: true }).click();
    for (const mode of ['video', 'model', 'cloud', 'map', 'fusion']) {
      await page.locator(`.mode-button[data-mode=${mode}]`).click();
      await page.waitForTimeout(100);
      const s = await state();
      assert.equal(s.mode, mode);
      assert.equal(s.orbit, false);
      assert.equal(s.pointCount, 757579);
      const expected = flight.samples.find((s) => s.t === 3).pos;
      for (let a = 0; a < 3; a++)
        assert.ok(
          Math.abs(s.position[a] - expected[a]) < 0.01,
          `${mode}: camera deviates from recorded pose`,
        );
    }
    await page.locator('.fusion-range').fill('35');
    await page.locator('.fusion-range').press('ArrowRight');
    assert.equal((await state()).split, 36);
    await page.locator('.wipe-handle').press('ArrowRight');
    assert.equal((await state()).split, 37);
    await page.getByRole('button', { name: 'Play flight', exact: true }).click();
    await page.waitForTimeout(350);
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
    assert.ok((await state()).time > 3.1);
    await page.getByRole('button', { name: 'Spatial view', exact: true }).click();
    assert.equal((await state()).orbit, true);
    await page.locator('.mode-button[data-mode=fusion]').click();
    assert.equal((await state()).orbit, false);
    await page.locator('.site-header [data-product]').click();
    assert.equal(await page.locator('dialog').evaluate((d) => d.open), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').evaluate((d) => d.open), false);
    await page.locator('.fusion-story').scrollIntoViewIfNeeded();
    await page.screenshot({ path: output + name + '-layers.png' });
    await page.locator('.detail-story').scrollIntoViewIfNeeded();
    await page.screenshot({ path: output + name + '-inspection.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await load(file);
    await layout();
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: output + name + '-mobile.png' });
    await page.locator('.detail-story').scrollIntoViewIfNeeded();
    await layout();
    if (name === 'atlas') {
      await page.locator('.enter-flight').click();
      assert.equal((await state()).orbit, false);
      assert.equal((await state()).mode, 'fusion');
    }
    results.push(
      `${name}: desktop/mobile, five views, recorded pose, keyboard wipe, play/pause, spatial camera, dialog, anonymous copy, images and overflow passed`,
    );
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load('index.html');
  assert.equal((await state()).playing, false);
  await page.locator('.mode-button[data-mode=cloud]').click();
  assert.equal((await state()).split, 100);
  results.push('Reduced motion: paused initial flight and immediate layer transition passed');
  assert.deepEqual(errors, []);
  console.log(results.join('\n'));
  console.log('No browser or HTTP errors.');
} finally {
  await browser.close();
}
