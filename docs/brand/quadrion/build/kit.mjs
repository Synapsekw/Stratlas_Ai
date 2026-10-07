// Quadrion AI brand kit: the Time steps mark, the outlined QUADRION AI wordmark
// (Archivo Expanded Bold, converted to paths so no font is needed), lockups,
// the app icon in the same format as packages/brand/icon.svg, a small-size cut,
// PNGs, an .ico, favicons and a one-page brand sheet.
// Writes ../kit/. Run: node kit.mjs  (needs `npm install` in this folder for opentype.js;
// sharp resolves from the repo root).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import opentype from 'opentype.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../../package.json'));
const sharp = require('sharp');
const kit = join(here, '..', 'kit');
for (const d of ['symbol', 'wordmark', 'lockup', 'icon', 'icon/png', 'favicon']) mkdirSync(join(kit, d), { recursive: true });

// ---------- colour (Mission) ----------
const C = {
  ground: '#11161C', // night slate: app chrome, icon tile
  panel: '#1E2630',
  ink: '#EEF2F5', // marks and type on dark
  mint: '#5ED1B3', // accent on dark
  paper: '#EEF2F4', // light ground
  inkL: '#11161C', // marks and type on light
  mintL: '#1A8C70', // accent on light (AA on paper for large type)
};

const f = (n) => +n.toFixed(2);

// ---------- the mark: Time steps ----------
// Four isometric plates, bottom to top, each stepping forward. Each plate is cut
// where the plates above overlap it (real transparency), so the mark works in one colour.
const CENTRES = [[26, 50], [30, 40], [34, 30], [38, 20]];
function mark(ink, acc, { hw = 21, hh = 8, gap = 5, prefix = 'm' } = {}) {
  const plate = ([cx, cy]) => `M${cx} ${cy - hh} L${cx + hw} ${cy} L${cx} ${cy + hh} L${cx - hw} ${cy}Z`;
  let defs = '', body = '';
  CENTRES.forEach((c, i) => {
    const above = CENTRES.slice(i + 1);
    const top = i === CENTRES.length - 1;
    if (!above.length) { body += `<path d="${plate(c)}" fill="${top ? acc : ink}"/>`; return; }
    const id = `${prefix}${i}`;
    defs += `<mask id="${id}" maskUnits="userSpaceOnUse" x="-16" y="-16" width="96" height="96"><rect x="-16" y="-16" width="96" height="96" fill="#fff"/>` +
      above.map((a) => `<path d="${plate(a)}" fill="#000" stroke="#000" stroke-width="${gap}" stroke-linejoin="miter"/>`).join('') + `</mask>`;
    body += `<path d="${plate(c)}" fill="${ink}" mask="url(#${id})"/>`;
  });
  return `<defs>${defs}</defs>${body}`;
}
// the mark's own bounds on the 64 grid (plates span x 5..59, y 12..58)
const MB = { x: 5, y: 12, w: 54, h: 46 };

// ---------- the wordmark, outlined ----------
const font = opentype.parse(readFileSync(join(here, 'fonts/Archivo-Expanded-Bold.woff')).buffer);
const UPM = font.unitsPerEm;
const TRACK = 0.1; // em, matches the board (letter-spacing .1em)
const AI_GAP = 0.42; // em before "AI"
/** Outline `text` at `size` px from x,y (baseline); returns { d, width }. */
function outline(text, size, x = 0, y = 0) {
  let pen = x, d = '';
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  const glyphs = font.stringToGlyphs(text);
  glyphs.forEach((g, i) => {
    const gp = g.getPath(pen, y, size);
    d += gp.toPathData(2);
    const b = gp.getBoundingBox();
    if (isFinite(b.x1)) { box.x1 = Math.min(box.x1, b.x1); box.y1 = Math.min(box.y1, b.y1); box.x2 = Math.max(box.x2, b.x2); box.y2 = Math.max(box.y2, b.y2); }
    pen += (g.advanceWidth / UPM) * size;
    if (i < glyphs.length - 1) pen += (font.getKerningValue(g, glyphs[i + 1]) / UPM) * size + TRACK * size;
  });
  return { d, width: pen - x, box };
}
const CAP = (font.tables.os2.sCapHeight || 700) / UPM; // cap height as a fraction of size

/** Wordmark at cap height `capPx`, origin top-left of the caps. */
function wordmark(capPx, ink, acc, withAI = true, x = 0, y = 0) {
  const size = capPx / CAP;
  const base = y + capPx;
  const q = outline('QUADRION', size, x, base);
  let out = `<path d="${q.d}" fill="${ink}"/>`, w = q.width;
  const box = { ...q.box };
  if (withAI) {
    const a = outline('AI', size, x + w + AI_GAP * size, base);
    out += `<path d="${a.d}" fill="${acc}"/>`;
    w += AI_GAP * size + a.width;
    box.x2 = Math.max(box.x2, a.box.x2); box.y1 = Math.min(box.y1, a.box.y1); box.y2 = Math.max(box.y2, a.box.y2);
  }
  return { svg: out, width: w, height: capPx, box };
}

const svgDoc = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(w)} ${f(h)}" width="${Math.round(w)}" height="${Math.round(h)}"><title>${title}</title>${body}</svg>\n`;

// ---------- lockups ----------
// Horizontal: mark height = 1.9 x cap height; gap = 0.55 x mark height; clear space = cap height.
function horizontal(ink, acc, bg, withAI = true, prefix = 'h') {
  const cap = 40, markH = cap * 1.9, s = markH / MB.h, pad = cap;
  const wm = wordmark(cap, ink, acc, withAI);
  const markW = MB.w * s, gap = markH * 0.42;
  const W = pad * 2 + markW + gap + wm.width, H = pad * 2 + markH;
  const wmY = pad + (markH - cap) / 2;
  return svgDoc(W, H,
    (bg ? `<rect width="${f(W)}" height="${f(H)}" fill="${bg}"/>` : '') +
    `<g transform="translate(${f(pad - MB.x * s)} ${f(pad - MB.y * s)}) scale(${f(s)})">${mark(ink, acc, { prefix })}</g>` +
    `<g transform="translate(${f(pad + markW + gap)} ${f(wmY)})">${wm.svg}</g>`,
    `Quadrion AI horizontal lockup`);
}
// Stacked: mark above, wordmark centred below.
function stacked(ink, acc, bg, prefix = 's') {
  const cap = 34, markH = 150, s = markH / MB.h, pad = 40;
  const wm = wordmark(cap, ink, acc, true);
  const markW = MB.w * s, gap = 34;
  const W = pad * 2 + Math.max(markW, wm.width), H = pad * 2 + markH + gap + cap;
  return svgDoc(W, H,
    (bg ? `<rect width="${f(W)}" height="${f(H)}" fill="${bg}"/>` : '') +
    `<g transform="translate(${f((W - markW) / 2 - MB.x * s)} ${f(pad - MB.y * s)}) scale(${f(s)})">${mark(ink, acc, { prefix })}</g>` +
    `<g transform="translate(${f((W - wm.width) / 2)} ${f(pad + markH + gap)})">${wm.svg}</g>`,
    'Quadrion AI stacked lockup');
}

// ---------- icons ----------
// Master: same format as packages/brand/icon.svg (512 tile, rx 112, mark at 6.4x).
const icon = (opts = {}) => {
  const { scale = 6.4, hw, hh, gap, title = 'Quadrion AI app icon', prefix = 'i' } = opts;
  const cx = MB.x + MB.w / 2, cy = MB.y + MB.h / 2;
  return svgDoc(512, 512,
    `<rect width="512" height="512" rx="112" fill="${C.ground}"/>` +
    `<g transform="translate(256 256) scale(${scale}) translate(${-cx} ${-cy})">${mark(C.ink, C.mint, { hw, hh, gap, prefix })}</g>`,
    title);
};
// Small cut for 16-32 px: mark larger in the tile and wider cuts so the four plates stay apart.
const iconSmall = () => icon({ scale: 8.4, gap: 7.5, title: 'Quadrion AI app icon, small-size cut (16-32 px)', prefix: 'k' });

// ---------- write SVGs ----------
const W = (p, s) => writeFileSync(join(kit, p), s);
const symbolDoc = (ink, acc, bg, name) => svgDoc(MB.w + 8, MB.h + 8,
  (bg ? `<rect width="${MB.w + 8}" height="${MB.h + 8}" fill="${bg}"/>` : '') + `<g transform="translate(${4 - MB.x} ${4 - MB.y})">${mark(ink, acc, { prefix: name })}</g>`, 'Quadrion AI symbol');
W('symbol/quadrion-symbol-on-dark.svg', symbolDoc(C.ink, C.mint, null, 'a'));
W('symbol/quadrion-symbol-on-light.svg', symbolDoc(C.inkL, C.mintL, null, 'b'));
W('symbol/quadrion-symbol-black.svg', symbolDoc('#000', '#000', null, 'c'));
W('symbol/quadrion-symbol-white.svg', symbolDoc('#fff', '#fff', null, 'd'));
for (const [name, ink, acc, ai] of [
  ['on-dark', C.ink, C.mint, true], ['on-light', C.inkL, C.mintL, true], ['black', '#000', '#000', true], ['white', '#fff', '#fff', true],
  ['no-ai-on-dark', C.ink, C.mint, false], ['no-ai-on-light', C.inkL, C.mintL, false],
]) {
  const wm = wordmark(60, ink, acc, ai);
  const b = wm.box, m = 2;
  W(`wordmark/quadrion-wordmark-${name}.svg`, svgDoc(b.x2 - b.x1 + 2 * m, b.y2 - b.y1 + 2 * m, `<g transform="translate(${f(m - b.x1)} ${f(m - b.y1)})">${wm.svg}</g>`, 'Quadrion AI wordmark'));
}
W('lockup/quadrion-horizontal-on-dark.svg', horizontal(C.ink, C.mint, null));
W('lockup/quadrion-horizontal-on-light.svg', horizontal(C.inkL, C.mintL, null));
W('lockup/quadrion-horizontal-black.svg', horizontal('#000', '#000', null));
W('lockup/quadrion-horizontal-white.svg', horizontal('#fff', '#fff', null));
W('lockup/quadrion-horizontal-no-ai-on-dark.svg', horizontal(C.ink, C.mint, null, false));
W('lockup/quadrion-stacked-on-dark.svg', stacked(C.ink, C.mint, null));
W('lockup/quadrion-stacked-on-light.svg', stacked(C.inkL, C.mintL, null));
const ICON = icon(), ICON_SMALL = iconSmall();
W('icon/icon.svg', ICON);
W('icon/icon-small.svg', ICON_SMALL);
W('favicon/favicon.svg', ICON_SMALL);

// ---------- rasters ----------
async function render(svg, size) {
  const density = Math.max(1, (72 * size) / 512);
  return sharp(Buffer.from(svg), { density }).resize(size, size).png().toBuffer();
}
const pick = (size) => (size <= 32 ? ICON_SMALL : ICON);
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const s of SIZES) W(`icon/png/${s}x${s}.png`, await render(pick(s), s));

// ICO: PNG entries (Vista+), 16/24/32 from the small cut
async function ico(sizes) {
  const imgs = [];
  for (const s of sizes) imgs.push({ s, data: await render(pick(s), s) });
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let off = 6 + 16 * imgs.length;
  const ents = imgs.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(off, 12);
    off += data.length; return e;
  });
  return Buffer.concat([head, ...ents, ...imgs.map((i) => i.data)]);
}
W('icon/icon.ico', await ico([16, 24, 32, 48, 64, 128, 256]));
W('favicon/favicon.ico', await ico([16, 32, 48]));
W('favicon/apple-touch-icon.png', await render(ICON, 180));

// ---------- brand sheet ----------
const inline = (p) => readFileSync(join(kit, p), 'utf8').replace(/<\?xml[^>]*>/, '');
const png = (s) => `data:image/png;base64,${readFileSync(join(kit, `icon/png/${s}x${s}.png`)).toString('base64')}`;
const sheet = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quadrion AI Brand Kit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a one-page brand sheet. Every logo shown is an outlined SVG from this kit,
   so the page shows exactly what ships. Chrome uses the Mission tokens. */
:root{color-scheme:dark;--bg-0:#0B0F13;--bg-1:${C.ground};--bg-2:${C.panel};--line:#2A3340;--fg-0:${C.ink};--fg-1:#C5CDD6;--fg-2:#8E99A6;--acc:${C.mint};--f-ui:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;--f-mono:'IBM Plex Mono',ui-monospace,Consolas,monospace}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){color-scheme:light;--bg-0:#F1F4F5;--bg-1:#FFFFFF;--bg-2:#E8EDEF;--line:#D6DEE2;--fg-0:${C.inkL};--fg-1:#33404C;--fg-2:#5D6B78;--acc:${C.mintL}}}
:root[data-theme="light"]{color-scheme:light;--bg-0:#F1F4F5;--bg-1:#FFFFFF;--bg-2:#E8EDEF;--line:#D6DEE2;--fg-0:${C.inkL};--fg-1:#33404C;--fg-2:#5D6B78;--acc:${C.mintL}}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg-0);color:var(--fg-1);font:15px/1.6 var(--f-ui);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:1180px;margin:0 auto;padding-inline:max(16px,env(safe-area-inset-left)) max(16px,env(safe-area-inset-right))}
@media (min-width:700px){.wrap{padding-inline:32px}}
header.top{border-bottom:1px solid var(--line);background:var(--bg-1)}
header.top .wrap{display:flex;align-items:center;min-height:52px;gap:16px;flex-wrap:wrap}
.eyebrow,.lbl,code{font-family:var(--f-mono)}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-2)}
.theme-btn{margin-left:auto;font:500 12px var(--f-ui);color:var(--fg-1);background:var(--bg-2);border:1px solid var(--line);border-radius:4px;padding:5px 12px;cursor:pointer}
.theme-btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
section{padding-block:38px;border-bottom:1px solid var(--line)}
h1{font-size:clamp(26px,3.6vw,34px);color:var(--fg-0);margin:0 0 8px;letter-spacing:-.015em}
h2{font-size:20px;color:var(--fg-0);margin:0 0 6px;font-weight:600}
p{margin:0 0 10px;max-width:68ch}
.hero{background:${C.ground};border-radius:10px;display:flex;align-items:center;justify-content:center;padding:56px 20px;margin-top:18px}
.hero svg,.tile svg{max-width:100%;height:auto}
.grid{display:grid;gap:12px;margin-top:16px}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:820px){.g2,.g4{grid-template-columns:1fr 1fr}}
@media (max-width:480px){.g2{grid-template-columns:1fr}}
.tile{border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:26px 16px;min-height:140px;border:1px solid var(--line)}
.lbl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;opacity:.65}
.icons{display:flex;align-items:flex-end;gap:18px;flex-wrap:wrap;background:#3A4553;border-radius:8px;padding:20px}
.icons figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:6px;color:${C.ink}}
.icons img{image-rendering:auto;display:block}
.sw{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
@media (max-width:820px){.sw{grid-template-columns:1fr 1fr}}
.sw div{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg-1)}
.sw i{display:block;height:70px}
.sw p{margin:0;padding:10px 12px;font-size:13px}.sw b{display:block;color:var(--fg-0)}
.sw code{font-size:12px;color:var(--fg-2)}
.rules{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
@media (max-width:820px){.rules{grid-template-columns:1fr}}
.rules div{border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--bg-1)}
.rules h3{margin:0 0 4px;font-size:14px;color:var(--fg-0)}
.rules p{font-size:13.5px;margin:0}
.files{font-size:13px}.files code{font-size:12.5px;color:var(--fg-0)}
footer{padding-block:24px;font-size:12.5px;color:var(--fg-2)}
</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="eyebrow">Synapse Solutions · Quadrion AI brand kit · v1 · 7 Oct 2026</span><button class="theme-btn" id="theme-btn" type="button">Theme: auto</button></div></header>
<main class="wrap">
<section>
  <h1>Quadrion AI</h1>
  <p>Mark: Time steps, four plates stepping forward as they rise, the top one lit. Type: Archivo Expanded Bold, outlined. Colour: Mission, the palette the app already uses. Tagline: <strong>Four dimensions. One view.</strong></p>
  <div class="hero">${inline('lockup/quadrion-horizontal-on-dark.svg')}</div>
</section>
<section>
  <h2>Lockups</h2>
  <p>Use the horizontal lockup by default and the stacked one where space is square. Clear space on every side equals the height of the capital letters. "AI" may be dropped where the product name is already clear (title bar, splash footers).</p>
  <div class="grid g2">
    <div class="tile" style="background:${C.paper}">${inline('lockup/quadrion-horizontal-on-light.svg')}<span class="lbl" style="color:${C.inkL}">On light</span></div>
    <div class="tile" style="background:${C.ground}">${inline('lockup/quadrion-horizontal-no-ai-on-dark.svg')}<span class="lbl" style="color:${C.ink}">Without AI</span></div>
    <div class="tile" style="background:#fff">${inline('lockup/quadrion-horizontal-black.svg')}<span class="lbl" style="color:#000">One colour, black</span></div>
    <div class="tile" style="background:#000">${inline('lockup/quadrion-horizontal-white.svg')}<span class="lbl" style="color:#fff">One colour, white</span></div>
    <div class="tile" style="background:${C.ground}">${inline('lockup/quadrion-stacked-on-dark.svg')}<span class="lbl" style="color:${C.ink}">Stacked, on dark</span></div>
    <div class="tile" style="background:${C.paper}">${inline('lockup/quadrion-stacked-on-light.svg')}<span class="lbl" style="color:${C.inkL}">Stacked, on light</span></div>
  </div>
</section>
<section>
  <h2>App icon</h2>
  <p>Real rendered PNGs at 1x, on a mid-grey ground so the tile edge shows. From 32 px down, the small-size cut takes over: the mark is larger in the tile and the cuts between plates are wider, so the four plates stay apart.</p>
  <div class="icons">${[256, 128, 64, 48, 32, 24, 16].map((s) => `<figure><img src="${png(s)}" width="${s}" height="${s}" alt="Quadrion AI icon at ${s} px"><span class="lbl">${s}</span></figure>`).join('')}</div>
</section>
<section>
  <h2>Colour</h2>
  <div class="sw">
    <div><i style="background:${C.ground}"></i><p><b>Night slate</b><code>${C.ground}</code><br>Ground, title bar, icon tile</p></div>
    <div><i style="background:${C.mint}"></i><p><b>Mint</b><code>${C.mint}</code><br>Accent on dark: lit plate, AI, focus</p></div>
    <div><i style="background:${C.paper}"></i><p><b>Paper</b><code>${C.paper}</code><br>Light ground, reports</p></div>
    <div><i style="background:${C.mintL}"></i><p><b>Deep mint</b><code>${C.mintL}</code><br>Accent on light grounds</p></div>
  </div>
  <p style="margin-top:12px;font-size:13px">Severity colours (red, amber, yellow) are separate from the brand and never change.</p>
</section>
<section>
  <h2>Rules</h2>
  <div class="rules">
    <div><h3>Keep the plates apart</h3><p>The cuts between plates are real transparency. Never fill them in or place the mark on a busy photo without a solid plate behind it.</p></div>
    <div><h3>One lit plate</h3><p>Only the top plate takes the accent. In one-colour use all four plates are the same colour.</p></div>
    <div><h3>Minimum size</h3><p>Horizontal lockup: 120 px wide on screen, 30 mm in print. Mark alone: 16 px, using the small-size cut.</p></div>
  </div>
</section>
<section>
  <h2>Files</h2>
  <p class="files"><code>symbol/</code> mark on dark, on light, black, white · <code>wordmark/</code> outlined QUADRION AI and QUADRION · <code>lockup/</code> horizontal and stacked · <code>icon/</code> icon.svg (same format as packages/brand/icon.svg), icon-small.svg, icon.ico, png/16 to 1024 · <code>favicon/</code> favicon.svg, favicon.ico, apple-touch-icon.png. Regenerate with <code>node docs/brand/quadrion/build/kit.mjs</code>.</p>
  <p class="files">The wordmark is set in Archivo Expanded Bold (SIL Open Font License, licence in build/fonts/OFL.txt) and converted to outlines, so no font is needed to use any file.</p>
</section>
</main>
<footer><div class="wrap">Synapse Solutions · Quadrion AI brand kit · name subject to trademark clearance.</div></footer>
<script>
(function(){var b=document.getElementById('theme-btn'),m=['auto','dark','light'],i=0;try{var s=localStorage.getItem('qk-theme');if(s&&m.indexOf(s)>=0)i=m.indexOf(s);}catch(e){}
function a(){var x=m[i];if(x==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',x);b.textContent='Theme: '+x;}a();
b.addEventListener('click',function(){i=(i+1)%m.length;a();try{localStorage.setItem('qk-theme',m[i]);}catch(e){}});})();
</script>
</body>
</html>
`;
W('index.html', sheet);
console.log('kit written to', kit);
