// Renders the board headless at desktop and phone width; reports overflow, broken images, row count.
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const url = pathToFileURL(path.resolve(import.meta.dirname, '..', 'index.html')).href;
const out = process.argv[2];
const b = await chromium.launch({ headless: true });
for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url, { waitUntil: 'networkidle' });
  const r = await p.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    broken: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
    rows: document.querySelectorAll('#ll tbody tr').length, height: document.documentElement.scrollHeight,
  }));
  console.log(tag, JSON.stringify(r), errors);
  await p.screenshot({ path: `${out}/board-${tag}-top.png` });
  await p.evaluate(() => document.querySelector('#longlist').scrollIntoView());
  await p.screenshot({ path: `${out}/board-${tag}-longlist.png` });
  await p.evaluate(() => document.querySelector('#almagest').scrollIntoView());
  await p.screenshot({ path: `${out}/board-${tag}-almagest.png` });
  await p.close();
}
await b.close();
