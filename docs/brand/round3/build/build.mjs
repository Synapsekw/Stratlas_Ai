// Builds every finalist asset into ../assets/<slug>/ : SVG marks in all variants,
// app icon PNGs (16..1024) with sharp, favicon (svg, png, ico) and test sheets.
// Run: node build.mjs   (from this folder; resolves sharp from the repo root)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { FINALISTS, PAL, C, symbolSVG, symbolInner, appIconSVG, wordmarkSVG, lockupSVG } from './marks.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const png = (svg, file, w, h) => sharp(Buffer.from(svg), { density: 72 }).resize(w, h ?? w).png().toFile(file);

function ico(pngBuffers, sizes) {
  const n = pngBuffers.length;
  const header = Buffer.alloc(6 + 16 * n);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  let offset = header.length;
  pngBuffers.forEach((b, i) => {
    const e = 6 + 16 * i, s = sizes[i];
    header.writeUInt8(s >= 256 ? 0 : s, e); header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(b.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += b.length;
  });
  return Buffer.concat([header, ...pngBuffers]);
}

const manifest = {};

for (const fz of FINALISTS) {
  const dir = path.join(ROOT, fz.slug);
  const m = (manifest[fz.slug] = { files: [] });
  const put = (rel, s) => { write(path.join(dir, rel), s); m.files.push(rel); };
  const T = (what) => `${fz.display}: ${what}`;

  // symbols: primary + alternate, 4 colourways, full and hinted cut
  for (const [role, key] of [['primary', fz.primary], ['alt', fz.alt]]) {
    for (const [cw, pal] of Object.entries({ dark: PAL.dark, light: PAL.light, 'mono-black': PAL.monoBlack, 'mono-white': PAL.monoWhite })) {
      put(`svg/symbol-${role}-${cw}.svg`, symbolSVG(key, pal, { size: 256, title: T(`${role} symbol, ${cw}`) }));
      put(`svg/symbol-${role}-${cw}-small.svg`, symbolSVG(key, pal, { small: true, size: 64, title: T(`${role} symbol, ${cw}, small-size cut`) }));
    }
    // lockups (transparent background; colourway says which ground it is for)
    for (const [cw, pal] of Object.entries({ dark: PAL.dark, light: PAL.light, 'mono-black': PAL.monoBlack, 'mono-white': PAL.monoWhite })) {
      put(`svg/lockup-${role}-${cw}.svg`, lockupSVG(key, fz.word, pal, { capPx: 30, title: T(`${role} lockup, ${cw}`) }));
    }
    put(`svg/lockup-${role}-dark-arabic.svg`, lockupSVG(key, fz.word, PAL.dark, { capPx: 30, arabic: fz.arabic, title: T(`${role} lockup with Arabic, dark`) }));
    put(`svg/lockup-${role}-light-arabic.svg`, lockupSVG(key, fz.word, PAL.light, { capPx: 30, arabic: fz.arabic, title: T(`${role} lockup with Arabic, light`) }));
  }
  for (const [cw, col] of Object.entries({ dark: C.fg0, light: C.ink, 'mono-black': '#000', 'mono-white': '#fff' })) {
    put(`svg/wordmark-${cw}.svg`, wordmarkSVG(fz.word, col, 40, { title: T(`wordmark, ${cw}`) }));
  }

  // app icons
  put('svg/appicon-dark.svg', appIconSVG(fz.primary, { title: T('app icon master, dark tile') }));
  put('svg/appicon-light.svg', appIconSVG(fz.primary, { variant: 'light', title: T('app icon, light tile') }));
  put('svg/appicon-small.svg', appIconSVG(fz.primary, { small: true, title: T('app icon, small-size cut (16 to 32 px)') }));
  put('svg/appicon-alt-dark.svg', appIconSVG(fz.alt, { title: T('alternate app icon, dark tile') }));
  fs.mkdirSync(path.join(dir, 'png'), { recursive: true });
  for (const s of SIZES) {
    const src = s <= 32 ? appIconSVG(fz.primary, { small: true, size: s }) : appIconSVG(fz.primary, { size: s });
    await png(src, path.join(dir, 'png', `icon-${s}.png`), s);
    m.files.push(`png/icon-${s}.png`);
  }
  for (const s of [256, 1024]) {
    await png(appIconSVG(fz.primary, { variant: 'light', size: s }), path.join(dir, 'png', `icon-light-${s}.png`), s);
    await png(appIconSVG(fz.alt, { size: s }), path.join(dir, 'png', `icon-alt-${s}.png`), s);
  }

  // favicon: hinted cut on a full-bleed dark tile
  const fav = appIconSVG(fz.primary, { small: true, size: 32, title: T('favicon') });
  put('favicon.svg', fav);
  const favPngs = [];
  for (const s of [16, 32, 48]) {
    const b = await sharp(Buffer.from(appIconSVG(fz.primary, { small: true, size: s }))).resize(s, s).png().toBuffer();
    favPngs.push(b);
    if (s !== 48) { fs.writeFileSync(path.join(dir, `favicon-${s}.png`), b); m.files.push(`favicon-${s}.png`); }
  }
  fs.writeFileSync(path.join(dir, 'favicon.ico'), ico(favPngs, [16, 32, 48]));
  m.files.push('favicon.ico');

  // ---- test sheets ----
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  // 1) pixel test: real 16/24/32 px renders, enlarged 8x with nearest neighbour, dark + light grounds
  const tiles = [];
  for (const ground of ['dark', 'light']) {
    for (const s of [16, 24, 32]) {
      const src = ground === 'dark'
        ? appIconSVG(fz.primary, { small: true, size: s })
        : symbolSVG(fz.primary, PAL.light, { small: true, size: s, bg: C.paper });
      const raw = await sharp(Buffer.from(src)).resize(s, s).png().toBuffer();
      const big = await sharp(raw).resize(s * 8, s * 8, { kernel: 'nearest' }).png().toBuffer();
      tiles.push({ big, s, ground });
    }
  }
  const pxW = 16 * 8 + 24 * 8 + 32 * 8 + 4 * 24, pxH = 2 * 32 * 8 + 3 * 24;
  let x = 24, y = 24; const comps = [];
  tiles.forEach((t, i) => {
    if (i === 3) { x = 24; y = 24 + 32 * 8 + 24; }
    comps.push({ input: t.big, left: x, top: y + (32 - t.s) * 4 });
    x += t.s * 8 + 24;
  });
  await sharp({ create: { width: pxW, height: pxH, channels: 4, background: '#6b7280' } }).composite(comps).png().toFile(path.join(dir, 'tests', 'pixels-16-24-32.png'));
  m.files.push('tests/pixels-16-24-32.png');

  // 2) silhouette + blur test: solid black symbol, then gaussian-blurred (squint test)
  const sil = symbolSVG(fz.primary, PAL.monoBlack, { size: 256, bg: '#ffffff' });
  const silAlt = symbolSVG(fz.alt, PAL.monoBlack, { size: 256, bg: '#ffffff' });
  const silB = await sharp(Buffer.from(sil)).resize(256, 256).png().toBuffer();
  const silBlur = await sharp(silB).blur(9).png().toBuffer();
  const silAltB = await sharp(Buffer.from(silAlt)).resize(256, 256).png().toBuffer();
  const silAltBlur = await sharp(silAltB).blur(9).png().toBuffer();
  await sharp({ create: { width: 256 * 4 + 5 * 16, height: 256 + 32, channels: 4, background: '#e5e7eb' } })
    .composite([silB, silBlur, silAltB, silAltBlur].map((b, i) => ({ input: b, left: 16 + i * (256 + 16), top: 16 })))
    .png().toFile(path.join(dir, 'tests', 'silhouette.png'));
  m.files.push('tests/silhouette.png');

  // 3) grounds sheet: icon + lockup on dark #0b0f14, Mission bg-1, paper, white, mid grey
  const grounds = [C.ground, C.bg1, '#2a313a', '#9aa3ad', C.paper, '#ffffff'];
  let g = '';
  grounds.forEach((bg, i) => {
    const darkGround = i < 3;
    const pal = darkGround ? PAL.dark : PAL.light;
    g += `<rect x="${i * 180}" y="0" width="180" height="200" fill="${bg}"/>`;
    g += `<g transform="translate(${i * 180 + 50} 30) scale(${80 / 64})">${symbolInner(fz.primary, pal)}</g>`;
    g += `<g transform="translate(${i * 180 + 66} 140) scale(${48 / 64})">${symbolInner(fz.primary, i === 3 ? PAL.monoBlack : pal, true)}</g>`;
  });
  await png(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="200">${g}</svg>`, path.join(dir, 'tests', 'grounds.png'), 1080, 200);
  m.files.push('tests/grounds.png');
  console.log('built', fz.slug, m.files.length, 'files');
}

write(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
