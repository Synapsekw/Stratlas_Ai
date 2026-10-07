// Quadrion AI identity exploration: marks, wordmarks with the AI treatment,
// colour directions, taglines and full combinations. Writes ../index.html and
// ../assets/. Run: node build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKS, ORDER, symbol, appIcon } from './marks.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NAME = 'QUADRION';

const PALETTES = [
  { key: 'signal', name: 'Signal', note: 'Near-black and electric blue. Precise, technical, the most "command centre" of the six.', ground: '#08090D', ink: '#EDF0F5', acc: '#3D7BFF', paper: '#F3F5F9', inkL: '#08090D', accL: '#1F55E0',
    sw: [['Obsidian', '#08090D'], ['Signal blue', '#3D7BFF'], ['Ice', '#CFE0FF'], ['Paper', '#F3F5F9'], ['Graphite', '#3A3F4C']] },
  { key: 'command', name: 'Command', note: 'Deep navy and amber, like an operations room at night. Serious and warm; suits government and energy buyers.', ground: '#0B1322', ink: '#ECF1F8', acc: '#F2A93B', paper: '#F4F6F9', inkL: '#0B1322', accL: '#B8730C',
    sw: [['Night navy', '#0B1322'], ['Amber', '#F2A93B'], ['Steel', '#3B4E6B'], ['Paper', '#F4F6F9'], ['Fog', '#A9B6C9']] },
  { key: 'mission', name: 'Mission', note: 'The app as it ships today: dark slate and mint. Choosing it means no UI repaint.', ground: '#11161C', ink: '#EEF2F5', acc: '#5ED1B3', paper: '#EEF2F4', inkL: '#11161C', accL: '#1A8C70',
    sw: [['Slate', '#11161C'], ['Mint', '#5ED1B3'], ['Panel', '#1E2630'], ['Paper', '#EEF2F4'], ['Severity red', '#E5484D']] },
  { key: 'tungsten', name: 'Tungsten', note: 'Charcoal and copper. Industrial and premium; closest to oil, gas and heavy plant.', ground: '#141312', ink: '#F1EEEA', acc: '#E08A4E', paper: '#F5F2EE', inkL: '#141312', accL: '#B4622A',
    sw: [['Charcoal', '#141312'], ['Copper', '#E08A4E'], ['Brass', '#C9A86A'], ['Paper', '#F5F2EE'], ['Iron', '#4D4844']] },
  { key: 'ultraviolet', name: 'Ultraviolet', note: 'Deep violet-black and UV light. The most futuristic and the most AI-forward.', ground: '#0D0B18', ink: '#EEEBF8', acc: '#8B7CFF', paper: '#F4F3FA', inkL: '#0D0B18', accL: '#5B45E0',
    sw: [['Void', '#0D0B18'], ['Ultraviolet', '#8B7CFF'], ['Haze', '#C7C1EE'], ['Paper', '#F4F3FA'], ['Dusk', '#433D5C']] },
  { key: 'daylight', name: 'Daylight', note: 'Light-first: white, ink and vermilion. Reads as engineering software and prints cleanly on reports.', ground: '#F5F5F3', ink: '#111318', acc: '#F0482A', paper: '#111318', inkL: '#F5F5F3', accL: '#FF7A5C',
    sw: [['Paper', '#F5F5F3'], ['Ink', '#111318'], ['Vermilion', '#F0482A'], ['Stone', '#D4D2CC'], ['Graphite', '#4A4D55']] },
];
const PAL = Object.fromEntries(PALETTES.map((p) => [p.key, p]));

const FONTS = [
  { key: 'archivo', name: 'Archivo Expanded, 700', note: 'Wide grotesque with weight. Closest in spirit to Palantir and Anduril.', css: "font-family:'Archivo',sans-serif;font-stretch:125%;font-weight:700;letter-spacing:.1em", scale: 0.56 },
  { key: 'syncopate', name: 'Syncopate, 700', note: 'Very wide, all caps by design. Feels like a mission patch.', css: "font-family:'Syncopate',sans-serif;font-weight:700;letter-spacing:.08em", scale: 0.5 },
  { key: 'michroma', name: 'Michroma', note: 'Wide and engineered, like an instrument panel.', css: "font-family:'Michroma',sans-serif;font-weight:400;letter-spacing:.1em", scale: 0.5 },
  { key: 'chakra', name: 'Chakra Petch, 600', note: 'Angular and technical, with a defence edge.', css: "font-family:'Chakra Petch',sans-serif;font-weight:600;letter-spacing:.14em", scale: 0.66 },
  { key: 'unbounded', name: 'Unbounded, 600', note: 'Round and geometric. Heavy but friendly.', css: "font-family:'Unbounded',sans-serif;font-weight:600;letter-spacing:.04em", scale: 0.52 },
  { key: 'redhat', name: 'Red Hat Display, 700', note: 'Clean and modern in caps; the most software-like and the easiest to read small.', css: "font-family:'Red Hat Display',sans-serif;font-weight:700;letter-spacing:.12em", scale: 0.66 },
];
const FONT = Object.fromEntries(FONTS.map((x) => [x.key, x]));

const COMBOS = [
  { id: 'a', title: 'Tesseract · Signal · Archivo', mark: 'tesseract', pal: 'signal', font: 'archivo', rec: true,
    why: 'The tesseract is the picture of four dimensions, and it says "the fourth dimension is time" without a word. Electric blue on near-black reads as a command centre. The wide caps carry the Palantir weight, and the filled centre keeps the icon readable at 16 px.' },
  { id: 'b', title: 'Q on a timeline · Command · Syncopate', mark: 'qaxis', pal: 'command', font: 'syncopate',
    why: 'A monogram that owns the letter Q, in navy and amber. The most corporate option and the easiest to recognise as an icon.' },
  { id: 'c', title: 'Four layers · Mission · Michroma', mark: 'layers', pal: 'mission', font: 'michroma',
    why: 'Fusion shown as four stacked plates, in the colours the app already uses. Nothing in the UI changes, and it continues the layered idea from Stratlas.' },
  { id: 'd', title: 'The quadrant · Tungsten · Chakra Petch', mark: 'quadrant', pal: 'tungsten', font: 'chakra',
    why: "The surveyor's instrument the name comes from, in copper on charcoal. The most industrial option, aimed at oil, gas and heavy plant." },
];

const TAGLINES = [
  'Four dimensions. One view.',
  'Every asset, in space and time.',
  'See what was. Know what is. Plan what comes.',
  'Every capture. Every date. One scene.',
  'Where every reality meets.',
  'The fourth dimension of asset intelligence.',
];

// ---------- export SVGs ----------
for (const k of ORDER) {
  const d = join(root, 'assets', 'marks', k);
  mkdirSync(d, { recursive: true });
  const c = PAL.signal;
  writeFileSync(join(d, 'symbol-dark.svg'), symbol(k, { ink: c.ink, acc: c.acc }, 512));
  writeFileSync(join(d, 'symbol-light.svg'), symbol(k, { ink: c.inkL, acc: c.accL }, 512));
  writeFileSync(join(d, 'symbol-mono.svg'), symbol(k, { ink: '#000000', acc: '#000000' }, 512));
  writeFileSync(join(d, 'appicon-signal.svg'), appIcon(k, { ground: c.ground, ink: c.ink, acc: c.acc }, 1024));
}
for (const C of COMBOS) {
  const p = PAL[C.pal];
  writeFileSync(join(root, 'assets', `combo-${C.id}-appicon.svg`), appIcon(C.mark, { ground: p.ground, ink: p.ink, acc: p.acc }, 1024));
}

// ---------- pieces ----------
// ai: null = name only; a colour = "AI" set beside the name in that colour
const word = (font, color, px, ai = null) => {
  const F = FONT[font];
  const tail = ai ? `<span class="ai" style="color:${ai}">AI</span>` : '';
  return `<span class="wm" style="${F.css};color:${color};font-size:${(px * F.scale).toFixed(1)}px">${NAME}${tail}</span>`;
};
const lockup = (mark, font, ink, acc, size, ai = true) =>
  `<div class="lockup">${symbol(mark, { ink, acc }, size)}${word(font, ink, size * 0.9, ai ? acc : null)}</div>`;

function stage(p) {
  const grid = [];
  for (let i = 0; i <= 10; i++) grid.push(`<line x1="${-40 + i * 40}" y1="150" x2="${110 + i * 10}" y2="78"/>`);
  for (const y of [86, 98, 114, 134]) grid.push(`<line x1="0" y1="${y}" x2="320" y2="${y}"/>`);
  return `<svg viewBox="0 0 320 150" class="stage-svg" aria-hidden="true"><rect width="320" height="150" fill="${p.ground}"/>
    <g stroke="${p.ink}" stroke-opacity=".12" stroke-width="1">${grid.join('')}</g>
    <g fill="${p.ink}" fill-opacity=".14" stroke="${p.ink}" stroke-opacity=".45" stroke-width="1"><path d="M128 52 V104 A32 9 0 0 0 192 104 V52"/><ellipse cx="160" cy="52" rx="32" ry="9"/></g>
    <path d="M40 40 C90 18 140 22 176 30 S260 50 290 30" fill="none" stroke="${p.acc}" stroke-width="1.6" stroke-dasharray="4 3"/>
    <path d="M176 30 L150 68 L196 70 Z" fill="${p.acc}" fill-opacity=".14" stroke="${p.acc}" stroke-opacity=".55" stroke-width=".8"/>
    <circle cx="176" cy="30" r="3.2" fill="${p.acc}"/>
    <g stroke="${p.ground}" stroke-width="1.2"><circle cx="146" cy="76" r="4.2" fill="#E5484D"/><circle cx="178" cy="92" r="4.2" fill="#F59E0B"/><circle cx="168" cy="62" r="4.2" fill="#EAB308"/></g></svg>`;
}

function contexts(mark, p, font) {
  const F = FONT[font];
  return `<div class="ctx">
    <figure class="ctx-win" style="--g:${p.ground};--i:${p.ink};--a:${p.acc}">
      <div class="tb">${appIcon(mark, p, 16)}<span style="${F.css};font-size:${(13 * F.scale).toFixed(1)}px">${NAME}</span><span class="tb-proj">Tank T-101 · synthetic sample</span><span class="tb-dots"><i></i><i></i><i></i></span></div>
      <div class="wbody"><div class="rail">${symbol(mark, p, 18)}<i></i><i></i><i></i><i></i></div><div class="st">${stage(p)}<div class="tl"><span class="tl-track"></span><span class="tl-head"></span></div></div></div>
      <figcaption>App window</figcaption>
    </figure>
    <figure class="ctx-splash" style="background:${p.ground};color:${p.ink}">
      <div class="splash-in">${symbol(mark, p, 58)}${word(font, p.ink, 34, p.acc)}<div class="splash-tag">${esc(TAGLINES[0])}</div><div class="splash-ver">Version 0.9.0 · Synapse Solutions</div></div>
      <figcaption>Splash</figcaption>
    </figure>
    <figure class="ctx-report" style="background:${p.paper};color:${p.inkL}">
      <div class="rep-head">${symbol(mark, { ink: p.inkL, acc: p.accL }, 20)}<span style="${F.css};font-size:${(12 * F.scale).toFixed(1)}px">${NAME}</span></div>
      <div class="rep-bar" style="background:${p.accL}"></div>
      <div class="rep-title">Asset review</div><div class="rep-sub">Tank T-101 · synthetic sample</div><div class="rep-date">October 2026</div>
      <figcaption>Report cover</figcaption>
    </figure>
  </div>`;
}

function markCard(k, i) {
  const M = MARKS[k], c = PAL.signal;
  return `<article class="mk" id="mark-${k}">
    <div class="mk-hero" style="background:${c.ground}">${symbol(k, c, 128)}</div>
    <div class="mk-row">
      <div class="mk-t" style="background:${c.paper}">${symbol(k, { ink: c.inkL, acc: c.accL }, 52)}</div>
      <div class="mk-t" style="background:#fff">${symbol(k, { ink: '#000', acc: '#000' }, 52)}</div>
      <div class="mk-t mk-sizes" style="background:${c.ground}">${appIcon(k, c, 32)}${appIcon(k, c, 16)}</div>
    </div>
    <h3><span class="num">${String(i + 1).padStart(2, '0')}</span>${esc(M.title)}</h3>
    <p>${esc(M.idea)}</p>
  </article>`;
}

function fontCard(F) {
  const c = PAL.signal;
  return `<article class="fc">
    <div class="fc-ground" style="background:${c.ground}">${word(F.key, c.ink, 70)}${word(F.key, c.ink, 70, c.acc)}</div>
    <h3>${esc(F.name)}</h3><p>${esc(F.note)}</p>
  </article>`;
}

function paletteCard(p) {
  return `<article class="pc">
    <div class="pc-show" style="background:${p.ground}">${lockup('tesseract', 'archivo', p.ink, p.acc, 46)}</div>
    <ul class="pc-sw">${p.sw.map(([n, h]) => `<li><span class="sw" style="background:${h}"></span><span class="sw-n">${esc(n)}</span><span class="sw-h">${h}</span></li>`).join('')}</ul>
    <h3>${esc(p.name)}</h3><p>${esc(p.note)}</p>
  </article>`;
}

function comboSheet(C) {
  const p = PAL[C.pal];
  return `<article class="combo" id="combo-${C.id}">
    <header class="combo-head"><h3>${C.rec ? '<span class="chip acc">Recommended</span>' : ''}${esc(C.title)}</h3><p>${esc(C.why)}</p></header>
    <div class="combo-grid">
      <div class="combo-hero" style="background:${p.ground}">${lockup(C.mark, C.font, p.ink, p.acc, 70)}</div>
      <div class="combo-side">
        <div class="combo-light" style="background:${p.paper}">${lockup(C.mark, C.font, p.inkL, p.accL, 34)}</div>
        <div class="combo-icons" style="background:${p.ground}">${appIcon(C.mark, p, 72)}${appIcon(C.mark, p, 40)}${appIcon(C.mark, p, 24)}${appIcon(C.mark, p, 16)}</div>
      </div>
    </div>
    ${contexts(C.mark, p, C.font)}
  </article>`;
}

const A = PAL.signal;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quadrion Identity</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Chakra+Petch:wght@500;600&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Michroma&family=Red+Hat+Display:wght@400..800&family=Syncopate:wght@400;700&family=Unbounded:wght@400..700&display=swap">
<style>
/* Layout: an identity workbook. Marks, type and colour are explored separately,
   then four full combinations show how they ship. Chrome stays neutral so the
   candidate colours carry the page. */
:root{
  color-scheme:dark;
  --bg-0:#0B0C10;--bg-1:#121419;--bg-2:#1A1C22;--line:#2A2D36;--line-soft:#1F2128;
  --fg-0:#F0F2F6;--fg-1:#C9CDD6;--fg-2:#9499A6;
  --acc:#6E9BFF;--acc-a12:rgba(61,123,255,.12);
  --warn:#E7B75A;--ok:#6FD39F;
  --f-ui:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;--f-mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;
}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){
  color-scheme:light;--bg-0:#F2F3F6;--bg-1:#FFFFFF;--bg-2:#ECEEF2;--line:#DADDE4;--line-soft:#E7E9EE;
  --fg-0:#13151A;--fg-1:#363A44;--fg-2:#5E6472;--acc:#1F55E0;--acc-a12:rgba(31,85,224,.08);--warn:#8A5A00;--ok:#1F7A4D;
}}
:root[data-theme="light"]{
  color-scheme:light;--bg-0:#F2F3F6;--bg-1:#FFFFFF;--bg-2:#ECEEF2;--line:#DADDE4;--line-soft:#E7E9EE;
  --fg-0:#13151A;--fg-1:#363A44;--fg-2:#5E6472;--acc:#1F55E0;--acc-a12:rgba(31,85,224,.08);--warn:#8A5A00;--ok:#1F7A4D;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg-0);color:var(--fg-1);font:15px/1.6 var(--f-ui);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:1240px;margin:0 auto;padding-inline:max(16px,env(safe-area-inset-left)) max(16px,env(safe-area-inset-right))}
@media (min-width:700px){.wrap{padding-inline:32px}}
header.top{border-bottom:1px solid var(--line);background:var(--bg-1)}
header.top .wrap{display:flex;align-items:center;gap:16px;min-height:52px;flex-wrap:wrap}
.eyebrow,.num,.chip,figcaption,.sw-h{font-family:var(--f-mono)}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-2)}
.theme-btn{margin-left:auto;font:500 12px var(--f-ui);color:var(--fg-1);background:var(--bg-2);border:1px solid var(--line);border-radius:4px;padding:5px 12px;cursor:pointer}
.theme-btn:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
h2{font-size:24px;font-weight:600;color:var(--fg-0);margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
h3{font-size:16px;font-weight:600;color:var(--fg-0);margin:0 0 4px}
p{margin:0 0 10px;max-width:68ch}
a{color:var(--acc)}
section{padding-block:44px;border-bottom:1px solid var(--line-soft)}
.lede{font-size:16.5px;max-width:70ch}
.note{font-size:12.5px;color:var(--fg-2)}
.chip{display:inline-flex;align-items:center;font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border:1px solid var(--line);border-radius:3px;margin-right:10px;vertical-align:2px}
.chip.acc{color:var(--acc);border-color:var(--acc)}
.chip.warn{color:var(--warn);border-color:color-mix(in oklab,var(--warn) 50%,transparent)}
.chip.ok{color:var(--ok);border-color:color-mix(in oklab,var(--ok) 50%,transparent)}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;margin-top:18px}
nav.toc a{color:var(--fg-2);text-decoration:none}nav.toc a:hover{color:var(--fg-0)}
.hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:28px;align-items:stretch;margin-top:8px}
.hero-mark{border-radius:8px;display:flex;align-items:center;justify-content:center;min-height:300px;padding:32px 16px;overflow:hidden}
.hero-copy{min-width:0;align-self:center}
.hero-copy h1{font-size:clamp(28px,4vw,38px);line-height:1.12;color:var(--fg-0);margin:0 0 12px;letter-spacing:-.015em;text-wrap:balance}
dl.kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 14px;margin:16px 0 0;font-size:13.5px}
dl.kv dt{color:var(--fg-2)}dl.kv dd{margin:0}
@media (max-width:900px){.hero{grid-template-columns:1fr}}
.lockup{display:flex;align-items:center;gap:.45em;max-width:100%}
.lockup svg{flex:none}
.wm{line-height:1;white-space:nowrap}
.wm .ai{margin-left:.42em;font-weight:inherit}
.marks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:22px}
@media (max-width:1100px){.marks{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.marks{grid-template-columns:1fr}}
.mk{border:1px solid var(--line);background:var(--bg-1);border-radius:8px;padding:12px;min-width:0}
.mk-hero{border-radius:6px;display:flex;align-items:center;justify-content:center;padding:24px 8px;min-height:170px}
.mk-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:8px 0 12px}
.mk-t{border-radius:6px;display:flex;align-items:center;justify-content:center;gap:8px;min-height:70px;border:1px solid var(--line-soft)}
.mk-t svg{max-width:100%;height:auto}
.mk h3{display:flex;gap:10px;align-items:baseline}
.num{font-size:11px;color:var(--fg-2)}
.mk p{font-size:13.5px;margin:0}
.fonts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:22px}
@media (max-width:820px){.fonts{grid-template-columns:1fr}}
.fc{min-width:0}
.fc-ground{border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:30px 12px;margin-bottom:10px;overflow:hidden}
.fc p{font-size:13.5px}
.pals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:22px}
@media (max-width:980px){.pals{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:560px){.pals{grid-template-columns:1fr}}
.pc{min-width:0}
.pc-show{border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;padding:26px 12px;min-height:150px;overflow:hidden}
.pc-sw{list-style:none;margin:0 0 12px;padding:10px 12px;display:grid;gap:6px;border:1px solid var(--line);border-top:0;border-radius:0 0 8px 8px;background:var(--bg-1)}
.pc-sw li{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:10px;align-items:center;font-size:13px}
.sw{width:22px;height:22px;border-radius:4px;border:1px solid var(--line)}
.sw-n{color:var(--fg-0)}.sw-h{font-size:12px;color:var(--fg-2)}
.pc p{font-size:13.5px}
.combo{padding-block:30px;border-top:1px solid var(--line-soft)}
.combo:first-of-type{border-top:0}
.combo-head{margin-bottom:14px}
.combo-head h3{font-size:20px}
.combo-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
@media (max-width:860px){.combo-grid{grid-template-columns:1fr}}
.combo-hero{border-radius:8px;display:flex;align-items:center;justify-content:center;min-height:240px;padding:24px 12px;overflow:hidden}
.combo-side{display:grid;gap:12px}
.combo-light{border-radius:8px;display:flex;align-items:center;justify-content:center;min-height:110px;border:1px solid var(--line-soft);overflow:hidden}
.combo-icons{border-radius:8px;display:flex;align-items:flex-end;justify-content:center;gap:16px;padding:18px;min-height:110px;flex-wrap:wrap}
.ctx{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,.8fr);gap:12px}
@media (max-width:940px){.ctx{grid-template-columns:1fr 1fr}.ctx-win{grid-column:1 / -1}}
@media (max-width:520px){.ctx{grid-template-columns:1fr}}
.ctx figure{margin:0;border-radius:8px;overflow:hidden;position:relative;border:1px solid var(--line);min-width:0}
.ctx figcaption{position:absolute;right:8px;bottom:6px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55}
.ctx-win{background:var(--g);color:var(--i)}
.tb{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-bottom:1px solid color-mix(in oklab,var(--i) 12%,transparent);background:color-mix(in oklab,var(--g) 85%,#000)}
.tb-proj{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tb-dots{margin-left:auto;display:flex;gap:6px}.tb-dots i{width:8px;height:8px;border-radius:50%;background:color-mix(in oklab,var(--i) 25%,transparent)}
.wbody{display:flex}
.rail{width:34px;flex:none;display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0;border-right:1px solid color-mix(in oklab,var(--i) 10%,transparent)}
.rail i{width:14px;height:14px;border-radius:3px;background:color-mix(in oklab,var(--i) 16%,transparent)}
.rail i:nth-of-type(1){background:var(--a)}
.st{flex:1;min-width:0}
.stage-svg{display:block;width:100%;height:auto}
.tl{position:relative;height:26px;border-top:1px solid color-mix(in oklab,var(--i) 10%,transparent)}
.tl-track{position:absolute;left:12px;right:12px;top:12px;height:2px;background:color-mix(in oklab,var(--i) 18%,transparent)}
.tl-head{position:absolute;left:58%;top:5px;width:2px;height:16px;background:var(--a)}
.ctx-splash{display:flex;align-items:center;justify-content:center;min-height:230px}
.splash-in{display:flex;flex-direction:column;align-items:center;gap:10px;padding:20px 12px 26px;text-align:center}
.splash-tag{font-size:13px;opacity:.85}
.splash-ver{font:11px var(--f-mono);opacity:.5;margin-top:4px}
.ctx-report{padding:16px 16px 30px;display:flex;flex-direction:column;min-height:230px}
.rep-head{display:flex;align-items:center;gap:6px}
.rep-bar{height:4px;width:44px;margin-top:auto;margin-bottom:10px}
.rep-title{font-size:19px;font-weight:600;line-height:1.15}
.rep-sub{font-size:12px;opacity:.7;margin-top:4px}
.rep-date{font:11px var(--f-mono);opacity:.6;margin-top:10px}
.tags{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:18px;padding:0;list-style:none}
.tags li{border:1px solid var(--line);background:var(--bg-1);border-radius:8px;padding:16px;color:var(--fg-0);font-size:17px;font-weight:500}
@media (max-width:760px){.tags{grid-template-columns:1fr}}
ul.plain{margin:6px 0 0;padding-left:18px}ul.plain li{margin-bottom:6px;max-width:72ch}
@media (max-width:560px){.hero-mark .lockup,.combo-hero .lockup,.combo-light .lockup,.fc-ground .wm,.pc-show .lockup,.splash-in .wm{zoom:.6}}
footer{padding-block:28px;font-size:12.5px;color:var(--fg-2)}
</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="eyebrow">Synapse Solutions · Brand · Quadrion AI identity · 7 Oct 2026</span><button class="theme-btn" id="theme-btn" type="button">Theme: auto</button></div></header>
<main class="wrap">
<section>
  <div class="hero">
    <div class="hero-mark" style="background:${A.ground}">${lockup('tesseract', 'archivo', A.ink, A.acc, 74)}</div>
    <div class="hero-copy">
      <h1>Quadrion AI: eight marks, six colour directions, six typefaces</h1>
      <p class="lede">Quadrion is built on quadr-, the Latin root for four. Four dimensions: the three of the scene plus time. Four kinds of capture fused into one view: models, point clouds, maps and video. And the quadrant, the instrument astronomers and surveyors used to measure the sky from one fixed place.</p>
      <p>Pick a mark, a colour direction and a typeface, or one of the four ready combinations at the end.</p>
      <dl class="kv">
        <dt>Free now</dt><dd><strong>quadrion.ai</strong>, <strong>quadrionai.com</strong>, quadrion.io, quadrion.app, quadrionhq.com, getquadrion.com (WHOIS and RDAP, 7 Oct 2026)</dd>
        <dt>Taken</dt><dd>quadrion.com</dd>
        <dt>Clear first</dt><dd><span class="chip warn">Attorney</span>No company or product called Quadrion was found. Closest: General Atomics' Quadratix (AI software for military drones), plus the Quadrant family of names. Counsel should clear it in classes 9 and 42.</dd>
      </dl>
    </div>
  </div>
  <nav class="toc"><a href="#marks">Marks</a><a href="#type">Wordmarks</a><a href="#colour">Colour</a><a href="#combos">Combinations</a><a href="#taglines">Taglines</a><a href="#next">Next steps</a></nav>
</section>

<section id="marks">
  <h2>Eight marks</h2>
  <p>All shown in the Signal colours so they compare fairly: on dark, on paper, in one colour, and as an app icon at 32 and 16 px. Each is built on a 64-unit grid and works in one colour.</p>
  <div class="marks">${ORDER.map(markCard).join('')}</div>
</section>

<section id="type">
  <h2>Six wordmarks, with and without AI</h2>
  <p>Each typeface is set as QUADRION, then as QUADRION AI with "AI" in the accent colour. The logo can carry AI or leave it to the domain and the store listing. The chosen typeface would be redrawn as outlines so it needs no font.</p>
  <div class="fonts">${FONTS.map(fontCard).join('')}</div>
</section>

<section id="colour">
  <h2>Six colour directions</h2>
  <p>Each shown with the Tesseract mark and the Archivo wordmark. Severity colours (red, amber, yellow) stay the same in every direction, because they mean the same thing on every project.</p>
  <div class="pals">${PALETTES.map(paletteCard).join('')}</div>
</section>

<section id="combos">
  <h2>Four combinations, as they would ship</h2>
  <p>Each shown as a lockup on dark and on paper, as an app icon at 72 to 16 px, and in the app window, splash screen and report cover.</p>
  ${COMBOS.map(comboSheet).join('\n')}
</section>

<section id="taglines">
  <h2>Taglines</h2>
  <ul class="tags">${TAGLINES.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
</section>

<section id="next">
  <h2>Next steps</h2>
  <ul class="plain">
    <li>Register quadrion.ai and quadrionai.com today, with quadrion.io and quadrionhq.com as spares. I have not registered anything.</li>
    <li>You pick a mark, a colour direction and a typeface, or one of the four combinations.</li>
    <li>A trademark attorney clears Quadrion in classes 9 and 42 in the US, EU and GCC, with Quadratix as the first comparison.</li>
    <li>I then outline the wordmark, cut the small-size icon, and rename the app from Stratlas in packages/brand (name, app ID, icons, installer art).</li>
  </ul>
  <p class="note">Files: assets/marks/&lt;mark&gt;/ (symbol dark, light, mono and a 1024 px app icon) · assets/combo-*-appicon.svg · build/ regenerates this page.</p>
</section>
</main>
<footer><div class="wrap">Synapse Solutions · Quadrion AI identity exploration · quick screen, not legal clearance · all scene and report content is synthetic.</div></footer>
<script>
(function(){
  var b=document.getElementById('theme-btn'),modes=['auto','dark','light'],i=0;
  try{var s=localStorage.getItem('quadrion-theme');if(s&&modes.indexOf(s)>=0)i=modes.indexOf(s);}catch(e){}
  function apply(){var m=modes[i];if(m==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',m);b.textContent='Theme: '+m;}
  apply();
  b.addEventListener('click',function(){i=(i+1)%modes.length;apply();try{localStorage.setItem('quadrion-theme',modes[i]);}catch(e){}});
})();
</script>
</body>
</html>
`;
writeFileSync(join(root, 'index.html'), html);
console.log('wrote index.html', html.length, 'bytes');
