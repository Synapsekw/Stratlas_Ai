#!/usr/bin/env node
// Render the app icon from packages/brand/icon.svg into every format the installers need:
//   apps/desktop/build/icon.ico            Windows exe, NSIS and portable
//   apps/desktop/build/icon.icns           macOS bundle (padded to the macOS icon grid)
//   apps/desktop/build/icon.png            1024 px fallback
//   apps/desktop/build/icons/<n>x<n>.png   loose PNG sizes
// Microsoft Store tiles (apps/desktop/build/appx/) and listing images come from store-assets.mjs.
// The outputs are committed. Run `pnpm icons` after the brand icon changes (it runs both).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { iconSource as source, render, root } from './icon-render.mjs';

const out = join(root, 'apps/desktop/build');

/** macOS icons sit on an 824 px plate inside a 1024 px canvas (Apple icon grid). */
const MAC_PLATE = 824 / 1024;

/** 32-bit BMP (DIB) entry for an ICO: BGRA bottom-up rows plus a 1-bit AND mask. */
async function dib(png, size) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = data[src + 2];
      pixels[dst + 1] = data[src + 1];
      pixels[dst + 2] = data[src];
      pixels[dst + 3] = data[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha channel decides transparency
  return Buffer.concat([header, pixels, mask]);
}

/** ICO with BMP entries below 256 px (widest compatibility, NSIS included) and PNG at 256. */
async function ico(sizes) {
  const images = [];
  for (const size of sizes) {
    const png = await render(size);
    images.push({ size, data: size >= 256 ? png : await dib(png, size) });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/** ICNS with PNG payloads for every slot macOS 10.13+ reads. */
async function icns() {
  const slots = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ];
  const cache = new Map();
  const chunks = [];
  for (const [type, size] of slots) {
    if (!cache.has(size)) cache.set(size, await render(size, MAC_PLATE));
    const data = cache.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

async function write(rel, data) {
  const file = join(out, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  process.stdout.write(`  ${rel} (${data.length} bytes)\n`);
}

process.stdout.write(`Rendering ${source}\n`);
await write('icon.ico', await ico([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]));
await write('icon.icns', await icns());
await write('icon.png', await render(1024));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await write(`icons/${size}x${size}.png`, await render(size));
}
