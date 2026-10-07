/**
 * HCl photos the right way up (founder report: the photos looking straight down were upside
 * down). Works on a temporary copy of the real HCl project without its video (realData.ts,
 * @realdata); runs only where the real data holds projects/hcl. The camera
 * originals on the NAS (QUADRION_HCL_ORIGINALS) are only read, and only for the issue box check.
 *
 * "Right way up" is measured against the scene: the project's LiDAR clouds rendered from the
 * photo's own pose (image +Y up) must agree with the photo as shown better than with the photo
 * turned half way round.
 */
import type { Page } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';
import { expect, realDataTest } from './fixtures';
import {
  grayOf,
  loadKitClouds,
  ncc,
  orientationScores,
  renderDepth,
  type Quat,
  type Vec3,
} from './orientation';
import { hasRealProject, missingRealProject } from './realData';

const ORIGINALS =
  process.env.QUADRION_HCL_ORIGINALS ??
  '//DanNas/Work Data/Asset Inspections/Oil and Gas/Hydrochloric Acid Tank';
const SHOTS = process.env.QUADRION_SHOTS;
/** Flight 110, outside, about 2 m above the roof looking 78 deg down. */
const NADIR = '110_0268';

interface PhotoItem {
  id: string;
  src: { path: string };
  pos?: Vec3;
  q?: Quat;
}
interface Manifest {
  layers: { kind: string; id: string; items?: PhotoItem[] }[];
}

/** What the copy keeps of the project: no video. */
const KEPT = new Set(['photos', 'models', 'clouds', 'flights', 'issues.json', 'manifest.json']);

const test = realDataTest(['hcl'], {
  prefix: 'aio-hcl-orient-',
  include: (rel) => KEPT.has(rel.split('/')[0] ?? ''),
  manifest: (m) => {
    const manifest = m as unknown as Manifest;
    return { ...m, layers: manifest.layers.filter((l) => l.kind !== 'video') };
  },
  size: [1440, 900],
}).extend<{ projectDir: string }>({
  projectDir: async ({ realData }, use) => {
    await use(realData.projectDir);
  },
});

test.skip(!hasRealProject('hcl'), missingRealProject('hcl'));
test.setTimeout(180_000);

function photoItem(projectDir: string, id: string): PhotoItem {
  const m = JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8')) as Manifest;
  const item = m.layers.find((l) => l.id === 'photos')?.items?.find((p) => p.id === id);
  if (!item) throw new Error(`photo ${id} not in the project`);
  return item;
}

/** Camera pitch (deg) from a camera quaternion: its -Z against the horizon. */
function pitchDeg([x, y, z, w]: Quat): number {
  // y component of q * (0, 0, -1)
  const fy = -(2 * (y * z - x * w));
  return (Math.asin(Math.max(-1, Math.min(1, fy))) * 180) / Math.PI;
}

async function openMedia(win: Page) {
  await win.getByTestId('project-card').filter({ hasText: 'HCl' }).first().click();
  const media = win.locator('.nav-item', { hasText: 'Media' }).first();
  await expect(media).toBeVisible({ timeout: 30_000 });
  await media.click();
}

/** Bytes of the image an <img> shows, read the way the page reads them. */
async function imageBytes(win: Page, selector: string): Promise<Buffer> {
  const b64 = await win.evaluate(async (sel) => {
    const img = document.querySelector<HTMLImageElement>(sel);
    if (!img) throw new Error(`no ${sel}`);
    const buf = new Uint8Array(await (await fetch(img.currentSrc || img.src)).arrayBuffer());
    let s = '';
    for (const c of buf) s += String.fromCharCode(c);
    return btoa(s);
  }, selector);
  return Buffer.from(b64, 'base64');
}

async function shot(win: Page, name: string) {
  if (SHOTS) await win.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test('@realdata a photo looking straight down shows the right way up in Media and the viewer', async ({
  projectDir,
  win,
}) => {
  const item = photoItem(projectDir, NADIR);
  if (!item.pos || !item.q) throw new Error(`${NADIR} has no pose`);
  expect(pitchDeg(item.q)).toBeLessThan(-60);
  const depth = renderDepth(loadKitClouds(projectDir), item.pos, item.q);

  // the file itself
  const file = await orientationScores(readFileSync(join(projectDir, item.src.path)), depth);
  expect(file.asShown, JSON.stringify(file)).toBeGreaterThan(file.turned + 0.05);

  await openMedia(win);
  const tile = win.locator(`.media [data-photo="${NADIR}"]`);
  await tile.scrollIntoViewIfNeeded();
  const tileImg = tile.locator('img');
  await expect
    .poll(() => tileImg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), {
      timeout: 30_000,
    })
    .toBe(true);
  // the grid thumbnail: its pixels, and nothing turns it on the way to the screen
  const thumb = await orientationScores(
    await imageBytes(win, `.media [data-photo="${NADIR}"] img`),
    depth,
  );
  expect(thumb.asShown, JSON.stringify(thumb)).toBeGreaterThan(thumb.turned + 0.05);
  expect(await tileImg.evaluate((i) => getComputedStyle(i).transform)).toBe('none');
  await shot(win, 'hcl-nadir-media');

  // the viewer, as drawn on screen
  await tile.click();
  const viewerImg = win.locator('.media-viewer img.ann-img').first();
  await expect(viewerImg).toBeVisible();
  await expect
    .poll(() => viewerImg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
    .toBe(true);
  await win.waitForTimeout(500);
  const shown = await orientationScores(await viewerImg.screenshot(), depth);
  expect(shown.asShown, JSON.stringify(shown)).toBeGreaterThan(shown.turned + 0.05);
  await shot(win, 'hcl-nadir-viewer');
});

/** Camera originals by lower-case base name, from the flight folders (`1NN-...`). */
function originals(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(ORIGINALS)) return out;
  for (const d of readdirSync(ORIGINALS).filter((n) => /^1\d\d-/.test(n))) {
    for (const f of readdirSync(join(ORIGINALS, d)))
      if (/\.jpe?g$/i.test(f))
        out.set(basename(f, extname(f)).toLowerCase(), join(ORIGINALS, d, f));
  }
  return out;
}

test('@realdata an issue box drawn on a photo covers the same defect as on the camera original', async ({
  projectDir,
  win,
}) => {
  const origs = originals();
  test.skip(origs.size === 0, `camera originals not reachable at ${ORIGINALS}`);
  const issues = (
    JSON.parse(readFileSync(join(projectDir, 'issues.json'), 'utf8')) as {
      issues: {
        code: string;
        sightings: {
          on: string;
          photo?: string;
          geom?: { type: string; x: number; y: number; w: number; h: number };
        }[];
      }[];
    }
  ).issues;
  const found = issues
    .flatMap((i) => i.sightings.map((s) => ({ code: i.code, s })))
    .find(
      ({ s }) =>
        s.on === 'image' && s.geom?.type === 'box' && s.photo && origs.has(s.photo.toLowerCase()),
    );
  test.skip(!found, 'no issue box on a photo with a camera original');
  if (!found?.s.photo || !found.s.geom) return;
  const { photo, geom: box } = found.s;
  const original = origs.get(photo.toLowerCase()) ?? '';

  await openMedia(win);
  const tile = win.locator(`.media [data-photo="${photo}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  const viewerImg = win.locator('.media-viewer img.ann-img').first();
  await expect
    .poll(() => viewerImg.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0))
    .toBe(true);
  const shape = win.locator('.media-viewer polygon.shape').first();
  await expect(shape).toBeVisible();
  await win.waitForTimeout(500);

  // where the viewer draws the box, in photo pixels
  const drawn = await win.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('.media-viewer img.ann-img');
    const poly = document.querySelector<SVGPolygonElement>('.media-viewer polygon.shape');
    if (!img || !poly) throw new Error('no viewer image or shape');
    const ir = img.getBoundingClientRect();
    const pr = poly.getBoundingClientRect();
    const k = img.naturalWidth / ir.width;
    return {
      x: (pr.left - ir.left) * k,
      y: (pr.top - ir.top) * k,
      w: pr.width * k,
      h: pr.height * k,
      nw: img.naturalWidth,
      nh: img.naturalHeight,
    };
  });
  const tol = 3;
  expect(Math.abs(drawn.x - box.x)).toBeLessThan(tol);
  expect(Math.abs(drawn.y - box.y)).toBeLessThan(tol);
  expect(Math.abs(drawn.w - box.w)).toBeLessThan(tol);
  expect(Math.abs(drawn.h - box.h)).toBeLessThan(tol);

  // what is inside the box on screen against the same box on the camera original, as the
  // camera meant it to be seen (EXIF Orientation applied) and turned the other way
  const screen = await viewerImg.screenshot();
  const sw = (await sharp(screen).metadata()).width;
  const s = sw / drawn.nw;
  const inset = (v: number, len: number) => Math.round(v + len * 0.12);
  const region = (k: number) => ({
    left: inset(box.x * k, box.w * k),
    top: inset(box.y * k, box.h * k),
    width: Math.round(box.w * k * 0.76),
    height: Math.round(box.h * k * 0.76),
  });
  const crop = async (img: Buffer, k: number) =>
    grayOf(await sharp(img).extract(region(k)).toBuffer(), 32, 32);
  const shownCrop = await crop(screen, s);
  const upright = await sharp(original)
    .rotate()
    .resize(drawn.nw, drawn.nh, { fit: 'fill' })
    .png()
    .toBuffer();
  const turned = await sharp(upright).rotate(180).png().toBuffer();
  const same = ncc(shownCrop, await crop(upright, 1));
  const other = ncc(shownCrop, await crop(turned, 1));
  expect(
    same,
    `${found.code} on ${photo}: ${same.toFixed(2)} vs ${other.toFixed(2)}`,
  ).toBeGreaterThan(0.6);
  expect(same).toBeGreaterThan(other + 0.2);
  await shot(win, `hcl-issue-box-${photo}`);
});
