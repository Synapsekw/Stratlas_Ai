// Quick contact sheet for design iteration (not part of the board).
import sharp from 'sharp';
import { symbolInner, wordmarkGroup, PAL, C, FINALISTS } from './marks.mjs';

const out = process.argv[2];
const cell = 150, cols = 6;
let body = '';
let row = 0;
const extra = {};
for (const fz of FINALISTS) {
  for (const key of [fz.primary, fz.alt, ...(extra[fz.slug] || [])]) {
    for (const [ci, pal] of [[0, PAL.dark], [1, PAL.light]]) {
      for (const [si, small] of [[0, false], [1, true]]) {
        const col = ci * 2 + si;
        const x = col * cell, y = row * cell;
        body += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${pal.ground}"/>`;
        body += `<g transform="translate(${x + 11} ${y + 11}) scale(${128 / 64})">${symbolInner(key, pal, small)}</g>`;
      }
    }
    // tiny sizes 16 / 32 on dark
    const x = 4 * cell, y = row * cell;
    body += `<rect x="${x}" y="${y}" width="${cell * 2}" height="${cell}" fill="${C.ground}"/>`;
    body += `<g transform="translate(${x + 10} ${y + 20}) scale(${32 / 64})">${symbolInner(key, PAL.dark, true)}</g>`;
    body += `<g transform="translate(${x + 60} ${y + 20}) scale(${16 / 64})">${symbolInner(key, PAL.dark, true)}</g>`;
    const wm = wordmarkGroup(fz.word, C.fg0, 14);
    body += `<g transform="translate(${x + 10} ${y + 90})">${wm.svg}</g>`;
    row++;
  }
}
const W = cols * cell, H = row * cell;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(out);
console.log('wrote', out, W, H);
