import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flareProject, privateNames } from './private-sources.mjs';
const require = createRequire(import.meta.url),
  { chromium } = require('@playwright/test'),
  sharp = require('sharp');
const here = path.dirname(fileURLToPath(import.meta.url)),
  out = path.resolve(here, '../assets/corrosion');
const data = JSON.parse(await readFile(path.join(out, 'data.json'), 'utf8'));
assert.equal(data.records.length, 78);
assert.deepEqual(
  privateNames(JSON.stringify(data)),
  [],
  'Private identity in exported presentation data',
);
const source = flareProject();
const original = JSON.parse(
  await readFile(path.join(source, 'models/patches/F04.json'), 'utf8'),
);
const record = data.records.find((r) => r.id === 'F04'),
  bin = await readFile(path.join(out, 'patches.bin'));
assert.deepEqual(record.center, original.center);
assert.equal(record.vertexCount, original.vertexCount);
for (let i = 0; i < original.positions.length; i++)
  assert.ok(
    Math.abs(bin.readFloatLE(record.offset + i * 4) - original.positions[i]) <
      0.00001,
    'Source surface geometry changed',
  );
for (let i = 0; i < original.uvs.length; i++)
  assert.ok(
    Math.abs(
      bin.readFloatLE(record.offset + record.vertexCount * 12 + i * 4) -
        original.uvs[i],
    ) < 0.000001,
    'Source patch UV changed',
  );
assert.deepEqual(
  await readFile(path.join(out, 'F04-patch.png')),
  await readFile(path.join(source, 'models/patches/F04.png')),
);
console.log(
  'Provenance passed: source surface coordinates, UV mapping and patch texture preserved.',
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
});
const url = 'http://127.0.0.1:8766/landing-options/';
const state = () => page.evaluate(() => window.corrosionPreview.getState());
const ready = () =>
  page.waitForFunction(
    () =>
      window.corrosionPreview?.getState().ready &&
      window.corrosionPreview.getState().photoReady,
  );
const stage = async () => {
  await page.locator('.corrosion-viewport').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
};
const photoColors = () =>
  page.evaluate(() => {
    const c = document.querySelector('.corrosion-photo-mask'),
      p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let yellow = 0,
      orange = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] > 0) {
        if (p[i + 1] > 175) yellow++;
        else orange++;
      }
    }
    return { yellow, orange };
  });
const scenePixels = async () => {
  await stage();
  return sharp(await page.locator('.corrosion-canvas').screenshot())
    .raw()
    .toBuffer({ resolveWithObject: true });
};
const countColor = (p) => {
  let n = 0;
  for (let i = 0; i < p.data.length; i += p.info.channels) {
    if (
      p.data[i] > 185 &&
      p.data[i + 1] > 70 &&
      p.data[i + 1] < 230 &&
      p.data[i + 2] < 100
    )
      n++;
  }
  return n;
};
const layout = async () => {
  const l = await page.evaluate(() => ({
    w: innerWidth,
    scroll: document.documentElement.scrollWidth,
    text: document.body.innerText,
  }));
  assert.ok(l.scroll <= l.w, `Horizontal overflow ${l.scroll}/${l.w}`);
  assert.deepEqual(privateNames(l.text), []);
};
try {
  await page.goto(url + 'corrosion.html');
  await ready();
  await stage();
  assert.equal((await state()).patchCount, 78);
  assert.equal(await page.locator('#corrosion-finding option').count(), 78);
  const on = await scenePixels();
  await page.locator('.toggle-masks').click();
  assert.equal((await state()).visibleCount, 0);
  const off = await scenePixels();
  assert.ok(
    countColor(on) > countColor(off) + 500,
    'Masks must visibly render on the 3D model',
  );
  await page.locator('.toggle-masks').click();
  await page.locator('#isolate-finding').check();
  assert.equal((await state()).visibleCount, 1);
  await page.locator('[data-class="moderate"]').click();
  let colors = await photoColors();
  assert.ok(colors.orange > 0);
  assert.equal(colors.yellow, 0);
  await page.locator('[data-class="light"]').click();
  colors = await photoColors();
  assert.ok(colors.yellow > 0);
  assert.equal(colors.orange, 0);
  await page.locator('[data-class="all"]').click();
  colors = await photoColors();
  assert.ok(colors.yellow > 0 && colors.orange > 0);
  await page.locator('#mask-opacity').fill('30');
  assert.equal((await state()).opacity, 0.3);
  assert.equal(
    await page
      .locator('.corrosion-photo-mask')
      .evaluate((el) => el.style.opacity),
    '0.3',
  );
  await page.locator('#mask-opacity').fill('85');
  await page.locator('#isolate-finding').uncheck();
  await page.locator('[data-view="photo"]').click();
  const camera = await state();
  record.camera.pos.forEach((n, i) =>
    assert.ok(Math.abs(n - camera.camera[i]) < 0.000001),
  );
  const q = record.camera.q,
    qn = Math.hypot(...q);
  q.forEach((n, i) =>
    assert.ok(Math.abs(n / qn - camera.quaternion[i]) < 0.000001),
  );
  await page.locator('[data-view="whole"]').click();
  await stage();
  assert.ok(Math.abs((await state()).target[1] - 40) < 0.01);
  await page
    .locator('.corrosion-workspace')
    .screenshot({ path: path.join(out, 'whole-stack-desktop.png') });
  for (const id of ['F47', 'F69', 'F04']) {
    await page.locator(`[data-finding="${id}"]`).click();
    await ready();
    await stage();
    assert.equal((await state()).selected, id);
    assert.ok(
      (await page.locator('.corrosion-source').getAttribute('src')).endsWith(
        `${id}.webp`,
      ),
    );
    assert.ok(
      (await page.locator('.selected-coordinate').innerText()).includes(
        data.records.find((r) => r.id === id).center[1].toFixed(1),
      ),
    );
  }
  await page.locator('.next-finding').click();
  await ready();
  assert.equal((await state()).selected, 'F05');
  await page.locator('.previous-finding').click();
  await ready();
  assert.equal((await state()).selected, 'F04');
  await page.locator('#corrosion-finding').selectOption('F61');
  await ready();
  assert.equal((await state()).selected, 'F61');
  await page.locator('#corrosion-finding').selectOption('F04');
  await ready();
  await stage();
  const before = (await state()).camera;
  const rect = await page.locator('.corrosion-canvas').boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width * 0.78,
    rect.y + rect.height * 0.52,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForTimeout(400);
  assert.notDeepEqual((await state()).camera, before);
  await page.locator('.reset-corrosion').click();
  await stage();
  await page
    .locator('.corrosion-workspace')
    .screenshot({ path: path.join(out, 'corrosion-desktop.png') });
  const rendered = await scenePixels(),
    box = await page.locator('.corrosion-canvas').boundingBox();
  let picked = false;
  for (let y = 90; y < rendered.info.height - 130 && !picked; y += 18) {
    for (let x = 80; x < rendered.info.width - 70 && !picked; x += 18) {
      const i = (y * rendered.info.width + x) * rendered.info.channels;
      if (
        rendered.data[i] > 200 &&
        rendered.data[i + 1] > 80 &&
        rendered.data[i + 1] < 220 &&
        rendered.data[i + 2] < 90
      ) {
        await page.mouse.click(box.x + x, box.y + y);
        picked = (await state()).selected !== 'F04';
      }
    }
  }
  assert.ok(
    picked,
    'Clicking a visible surface mask should select another mapped finding',
  );
  await ready();
  await layout();
  console.log(
    'Desktop passed: visible 3D masks, class filters, opacity, isolation, original camera pose, orbit, surface picking and linked evidence.',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await ready();
  await layout();
  await page.locator('.menu-toggle').click();
  assert.equal(
    await page.locator('#site-navigation').getAttribute('data-open'),
    'true',
  );
  await page.locator('.menu-toggle').click();
  await stage();
  await page.screenshot({ path: path.join(out, 'corrosion-mobile.png') });
  const order = await page.evaluate(() =>
    ['.corrosion-viewport', '.corrosion-controls', '.corrosion-evidence'].map(
      (s) => document.querySelector(s).getBoundingClientRect().top,
    ),
  );
  assert.ok(
    order[0] < order[1] && order[1] < order[2],
    'Mobile controls should precede evidence',
  );
  await page.locator('[data-view="whole"]').click();
  await page.waitForTimeout(1200);
  assert.equal((await state()).view, 'whole');
  await page.locator('[data-view="detail"]').click();
  await page.waitForTimeout(1100);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-view="whole"]').click();
  assert.equal((await state()).target[1], 40);
  await page.locator('[data-view="detail"]').click();
  await layout();
  console.log(
    'Mobile passed: layout, control order, navigation and reduced-motion camera changes.',
  );
  for (const viewport of [
    { width: 1440, height: 1050 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const route of [
      'atlas.html',
      'index.html',
      'confined-spaces.html',
      'evidence.html',
      'reporting.html',
    ]) {
      await page.goto(url + route);
      await page
        .locator('a[href="corrosion.html"]')
        .first()
        .waitFor({ state: 'attached' });
      await layout();
      if (route === 'confined-spaces.html') {
        await page.locator('.corrosion-teaser').scrollIntoViewIfNeeded();
        await page
          .locator('.corrosion-teaser img')
          .evaluate((img) => img.decode());
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Both landing directions and all product pages link to the explorer. No browser or HTTP errors.',
  );
} finally {
  await browser.close();
}
