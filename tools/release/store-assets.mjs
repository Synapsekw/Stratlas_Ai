#!/usr/bin/env node
// Microsoft Store images from the brand icon (packages/brand/icon.svg):
//   apps/desktop/build/appx/                    MSIX tile and logo assets at every scale
//   docs/release/store-listing/images/          Partner Center listing images (logo, box art,
//                                               poster art, hero)
// The outputs are committed. `pnpm icons` runs this after icons.mjs.
//
// Scale-qualified MSIX assets (`Name.scale-200.png`, `Square44x44Logo.targetsize-48.png`) make
// electron-builder index them with makepri, so Windows picks a crisp image for every display
// scale, Start, taskbar and the Store. Unqualified copies are removed: two candidates for the
// same resource would make makepri fail.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { WORDMARK } from '../../packages/brand/src/marks.ts';
import { render, root, tile, TILE_BG } from './icon-render.mjs';

/** Brand kit colours on dark: ink for QUADRION, mint for AI. */
const INK = '#EEF2F5';
const MINT = '#5ED1B3';

/** Display scales Windows asks for (percent). */
export const SCALES = [100, 125, 150, 200, 400];
/** Taskbar and Start list sizes for the app icon (px), plain and unplated. */
export const TARGET_SIZES = [16, 24, 32, 48, 256];

/**
 * MSIX visual assets at 100 % scale. `kind`: `icon` is the rounded app icon on transparency,
 * `tile` the icon on a solid brand tile. Sizes follow Microsoft's app icon guidance.
 */
export const APPX_ASSETS = [
  { name: 'StoreLogo', w: 50, h: 50, kind: 'icon' },
  { name: 'Square44x44Logo', w: 44, h: 44, kind: 'icon' },
  { name: 'SmallTile', w: 71, h: 71, kind: 'tile' },
  { name: 'Square150x150Logo', w: 150, h: 150, kind: 'tile' },
  { name: 'Wide310x150Logo', w: 310, h: 150, kind: 'tile' },
  { name: 'LargeTile', w: 310, h: 310, kind: 'tile' },
];

/** Every file in build/appx/ with its pixel size. */
export function appxFiles() {
  const files = [];
  for (const a of APPX_ASSETS) {
    for (const s of SCALES) {
      files.push({
        file: `${a.name}.scale-${s}.png`,
        w: Math.round((a.w * s) / 100),
        h: Math.round((a.h * s) / 100),
        kind: a.kind,
      });
    }
  }
  for (const size of TARGET_SIZES) {
    for (const suffix of ['', '_altform-unplated']) {
      files.push({
        file: `Square44x44Logo.targetsize-${size}${suffix}.png`,
        w: size,
        h: size,
        kind: 'icon',
      });
    }
  }
  return files;
}

/**
 * Partner Center Store listing images (Store listing, Store logos and display images). The
 * 1:1 app tile icon is optional but recommended; box art and poster art are what Windows 10/11
 * show in the Store; the hero image is needed only for featuring.
 */
export const LISTING_IMAGES = [
  { file: 'app-tile-icon-300x300.png', w: 300, h: 300, title: false },
  { file: 'box-art-1080x1080.png', w: 1080, h: 1080, title: true },
  { file: 'box-art-2160x2160.png', w: 2160, h: 2160, title: true },
  { file: 'poster-art-720x1080.png', w: 720, h: 1080, title: true },
  { file: 'poster-art-1440x2160.png', w: 1440, h: 2160, title: true },
  { file: 'hero-1920x1080.png', w: 1920, h: 1080, title: true },
  { file: 'hero-3840x2160.png', w: 3840, h: 2160, title: true },
];

const appxDir = join(root, 'apps/desktop/build/appx');
const listingDir = join(root, 'docs/release/store-listing/images');

/** The outlined wordmark (packages/brand/src/marks.ts) on dark, `width` px wide. */
function wordmark(width) {
  const [, , vw, vh] = WORDMARK.viewBox.split(' ').map(Number);
  const height = Math.round((width * vh) / vw);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${WORDMARK.viewBox}" width="${width}" height="${height}">` +
    `<g transform="${WORDMARK.transform}"><path d="${WORDMARK.quadrion}" fill="${INK}"/>` +
    `<path d="${WORDMARK.ai}" fill="${MINT}"/></g></svg>`;
  return { input: Buffer.from(svg), height };
}

/** Icon above the outlined wordmark, the stacked lockup of the brand kit. */
async function titled(w, h) {
  const side = Math.round(Math.min(w, h) * 0.42);
  const wordWidth = Math.round(side * 1.9);
  const word = wordmark(wordWidth);
  const gap = Math.round(side * 0.2);
  const top = Math.round((h - side - gap - word.height) / 2);
  return sharp({ create: { width: w, height: h, channels: 4, background: TILE_BG } })
    .composite([
      { input: await render(side), left: Math.floor((w - side) / 2), top },
      { input: word.input, left: Math.floor((w - wordWidth) / 2), top: top + side + gap },
    ])
    .png()
    .toBuffer();
}

async function write(dir, file, data) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), data);
  process.stdout.write(`  ${file} (${data.length} bytes)\n`);
}

export async function writeStoreAssets() {
  // Unqualified and stale files would compete with the scaled ones in resources.pri.
  await mkdir(appxDir, { recursive: true });
  for (const f of await readdir(appxDir)) {
    if (f.endsWith('.png')) await rm(join(appxDir, f));
  }
  process.stdout.write(`MSIX assets in ${appxDir}\n`);
  for (const f of appxFiles()) {
    const data = f.kind === 'icon' ? await render(f.w) : await tile(f.w, f.h, 0.66);
    await write(appxDir, f.file, data);
  }
  process.stdout.write(`Listing images in ${listingDir}\n`);
  for (const img of LISTING_IMAGES) {
    const data = img.title ? await titled(img.w, img.h) : await tile(img.w, img.h, 0.8);
    await write(listingDir, img.file, data);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await writeStoreAssets();
}
