// Rasterise the brand icon (packages/brand/icon.svg) for installers and Store assets.
// Shared by icons.mjs (ico, icns, png) and store-assets.mjs (MSIX tiles, listing images).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const iconSource = join(root, 'packages/brand/icon.svg');

/** Tile background for Store assets; matches the icon's own plate colour. */
export const TILE_BG = '#18202B';

const svg = readFileSync(iconSource);

/** Render the icon at `size` px, optionally inset by `scale` on a transparent canvas. */
export async function render(size, scale = 1) {
  const inner = Math.round(size * scale);
  // Render at the target resolution (not a downscaled bitmap) so small sizes stay crisp.
  const density = Math.max(1, (72 * inner) / 512);
  const img = await sharp(svg, { density }).resize(inner, inner).png().toBuffer();
  if (inner === size) return img;
  const pad = Math.floor((size - inner) / 2);
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: img, left: pad, top: pad }])
    .png()
    .toBuffer();
}

/** Icon centred on a solid tile of `w` x `h`, icon height `iconFraction` of the shorter side. */
export async function tile(w, h, iconFraction) {
  const side = Math.round(Math.min(w, h) * iconFraction);
  const icon = await render(side);
  return sharp({ create: { width: w, height: h, channels: 4, background: TILE_BG } })
    .composite([{ input: icon, left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2) }])
    .png()
    .toBuffer();
}
