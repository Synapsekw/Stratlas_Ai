// Quadrion AI: refinement of the chosen direction (Four layers, Mission colours,
// Archivo Expanded 700). Writes ../final/index.html and ../final/assets/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARKS, symbol, appIcon } from './marks.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'final');
mkdirSync(join(out, 'assets'), { recursive: true });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const M = { ground: '#11161C', ink: '#EEF2F5', acc: '#5ED1B3', paper: '#EEF2F4', inkL: '#11161C', accL: '#1A8C70', panel: '#1E2630' };
const VARIANTS = ['layers', 'layersStep', 'layersQuad', 'layersAxis'];
const REC = 'layersStep';
const WM = "font-family:'Archivo',sans-serif;font-stretch:125%;font-weight:700;letter-spacing:.1em";

const word = (color, px, ai) => `<span class="wm" style="${WM};color:${color};font-size:${(px * 0.56).toFixed(1)}px">QUADRION${ai ? `<span class="ai" style="color:${ai}">AI</span>` : ''}</span>`;
const lockup = (k, ink, acc, size) => `<div class="lockup">${symbol(k, { ink, acc }, size)}${word(ink, size * 0.9, acc)}</div>`;

// the generic "layers" icon most apps use, for comparison
const generic = (c, s) => `<svg viewBox="0 0 64 64" width="${s}" height="${s}" aria-hidden="true"><path d="M32 10 L56 22 L32 34 L8 22Z" fill="none" stroke="${c}" stroke-width="4" stroke-linejoin="round"/><path d="M8 32 L32 44 L56 32 M8 42 L32 54 L56 42" fill="none" stroke="${c}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;

for (const k of VARIANTS) {
  writeFileSync(join(out, 'assets', `${k}-dark.svg`), symbol(k, { ink: M.ink, acc: M.acc }, 512));
  writeFileSync(join(out, 'assets', `${k}-light.svg`), symbol(k, { ink: M.inkL, acc: M.accL }, 512));
  writeFileSync(join(out, 'assets', `${k}-mono.svg`), symbol(k, { ink: '#000', acc: '#000' }, 512));
  writeFileSync(join(out, 'assets', `${k}-appicon.svg`), appIcon(k, { ground: M.ground, ink: M.ink, acc: M.acc }, 1024));
}

function card(k) {
  const X = MARKS[k];
  const rec = k === REC;
  return `<article class="v${rec ? ' rec' : ''}" id="v-${k}">
    <header><h3>${rec ? '<span class="chip">Recommended</span>' : ''}${esc(X.title)}${k === 'layers' ? ' <span class="muted">(as chosen)</span>' : ''}</h3></header>
    <div class="hero" style="background:${M.ground}">${lockup(k, M.ink, M.acc, 64)}</div>
    <div class="row">
      <div class="t" style="background:${M.paper}">${lockup(k, M.inkL, M.accL, 30)}</div>
      <div class="t" style="background:#fff">${symbol(k, { ink: '#000', acc: '#000' }, 48)}</div>
      <div class="t icons" style="background:${M.ground}">${appIcon(k, M, 64)}${appIcon(k, M, 32)}${appIcon(k, M, 24)}${appIcon(k, M, 16)}</div>
    </div>
    <p>${esc(X.idea)}</p>
  </article>`;
}

function stage() {
  const p = M, grid = [];
  for (let i = 0; i <= 10; i++) grid.push(`<line x1="${-40 + i * 40}" y1="150" x2="${110 + i * 10}" y2="78"/>`);
  for (const y of [86, 98, 114, 134]) grid.push(`<line x1="0" y1="${y}" x2="320" y2="${y}"/>`);
  return `<svg viewBox="0 0 320 150" class="stage" aria-hidden="true"><rect width="320" height="150" fill="${p.ground}"/>
    <g stroke="${p.ink}" stroke-opacity=".12">${grid.join('')}</g>
    <g fill="${p.ink}" fill-opacity=".14" stroke="${p.ink}" stroke-opacity=".45"><path d="M128 52 V104 A32 9 0 0 0 192 104 V52"/><ellipse cx="160" cy="52" rx="32" ry="9"/></g>
    <path d="M40 40 C90 18 140 22 176 30 S260 50 290 30" fill="none" stroke="${p.acc}" stroke-width="1.6" stroke-dasharray="4 3"/>
    <path d="M176 30 L150 68 L196 70 Z" fill="${p.acc}" fill-opacity=".14" stroke="${p.acc}" stroke-opacity=".55" stroke-width=".8"/><circle cx="176" cy="30" r="3.2" fill="${p.acc}"/>
    <g stroke="${p.ground}" stroke-width="1.2"><circle cx="146" cy="76" r="4.2" fill="#E5484D"/><circle cx="178" cy="92" r="4.2" fill="#F59E0B"/><circle cx="168" cy="62" r="4.2" fill="#EAB308"/></g></svg>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Quadrion Mark Refinement</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: four refinements side by side, then the recommended one in the app.
   Chrome uses the Mission tokens the app already ships with. */
:root{color-scheme:dark;--bg-0:#0B0F13;--bg-1:#11161C;--bg-2:#1E2630;--line:#2A3340;--fg-0:#EEF2F5;--fg-1:#C5CDD6;--fg-2:#8E99A6;--acc:#5ED1B3;--acc-a12:rgba(94,209,179,.10);--f-ui:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;--f-mono:'IBM Plex Mono',ui-monospace,Consolas,monospace}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){color-scheme:light;--bg-0:#F1F4F5;--bg-1:#FFFFFF;--bg-2:#E8EDEF;--line:#D6DEE2;--fg-0:#11161C;--fg-1:#33404C;--fg-2:#5D6B78;--acc:#1A8C70;--acc-a12:rgba(26,140,112,.08)}}
:root[data-theme="light"]{color-scheme:light;--bg-0:#F1F4F5;--bg-1:#FFFFFF;--bg-2:#E8EDEF;--line:#D6DEE2;--fg-0:#11161C;--fg-1:#33404C;--fg-2:#5D6B78;--acc:#1A8C70;--acc-a12:rgba(26,140,112,.08)}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg-0);color:var(--fg-1);font:15px/1.6 var(--f-ui);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:1240px;margin:0 auto;padding-inline:max(16px,env(safe-area-inset-left)) max(16px,env(safe-area-inset-right))}
@media (min-width:700px){.wrap{padding-inline:32px}}
header.top{border-bottom:1px solid var(--line);background:var(--bg-1)}
header.top .wrap{display:flex;align-items:center;min-height:52px;gap:16px;flex-wrap:wrap}
.eyebrow{font:500 11px var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--fg-2)}
.theme-btn{margin-left:auto;font:500 12px var(--f-ui);color:var(--fg-1);background:var(--bg-2);border:1px solid var(--line);border-radius:4px;padding:5px 12px;cursor:pointer}
.theme-btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
section{padding-block:40px;border-bottom:1px solid var(--line)}
h1{font-size:clamp(26px,3.6vw,34px);line-height:1.15;color:var(--fg-0);margin:0 0 10px;letter-spacing:-.015em;text-wrap:balance}
h2{font-size:22px;color:var(--fg-0);margin:0 0 6px;font-weight:600}
h3{font-size:16px;color:var(--fg-0);margin:0;font-weight:600;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
p{margin:0 0 10px;max-width:68ch}
.muted{color:var(--fg-2);font-weight:400}
.chip{font:500 11px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--acc);border:1px solid var(--acc);border-radius:3px;padding:3px 8px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:20px}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
.v{border:1px solid var(--line);background:var(--bg-1);border-radius:8px;padding:14px;display:grid;gap:10px;min-width:0}
.v.rec{border-color:var(--acc);background:linear-gradient(var(--acc-a12),var(--acc-a12)),var(--bg-1)}
.hero{border-radius:6px;display:flex;align-items:center;justify-content:center;min-height:190px;padding:20px 10px;overflow:hidden}
.row{display:grid;grid-template-columns:1.4fr .8fr 1.4fr;gap:8px}
.t{border-radius:6px;display:flex;align-items:center;justify-content:center;gap:12px;min-height:92px;padding:8px;overflow:hidden}
.t.icons{align-items:flex-end;padding-bottom:16px}
@media (max-width:560px){.row{grid-template-columns:1fr 1fr}.row .t:first-child{grid-column:1 / -1}.hero .lockup,.t .lockup,.ctx .lockup{zoom:.6}}
.v p{font-size:13.5px;margin:0}
.lockup{display:flex;align-items:center;gap:.45em}.lockup svg{flex:none}
.wm{line-height:1;white-space:nowrap}.wm .ai{margin-left:.42em}
.cmp{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
.cmp figure{margin:0;background:${M.ground};border-radius:6px;padding:14px 18px;display:flex;flex-direction:column;align-items:center;gap:8px;min-width:120px}
.cmp figcaption{font:500 11px var(--f-mono);color:${M.ink};opacity:.7;text-transform:uppercase;letter-spacing:.05em}
.ctx{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,.8fr);gap:12px;margin-top:18px}
@media (max-width:940px){.ctx{grid-template-columns:1fr 1fr}.win{grid-column:1 / -1}}
@media (max-width:520px){.ctx{grid-template-columns:1fr}}
.ctx figure{margin:0;border-radius:8px;overflow:hidden;border:1px solid var(--line);min-width:0}
.win{background:${M.ground};color:${M.ink}}
.tb{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;background:#0D1116;border-bottom:1px solid ${M.panel}}
.tb small{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbody{display:flex}.rail{width:34px;flex:none;display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0;border-right:1px solid ${M.panel}}
.rail i{width:14px;height:14px;border-radius:3px;background:${M.panel}}.rail i:first-of-type{background:${M.acc}}
.stage{display:block;width:100%;height:auto}
.splash{background:${M.ground};color:${M.ink};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:230px;padding:20px;text-align:center}
.splash small{font:11px var(--f-mono);opacity:.5}
.report{background:${M.paper};color:${M.inkL};padding:16px;display:flex;flex-direction:column;min-height:230px}
.report .bar{height:4px;width:44px;background:${M.accL};margin-top:auto;margin-bottom:10px}
.report b{font-size:19px}.report span{font-size:12px;opacity:.7}
ul.plain{padding-left:18px;margin:8px 0 0}ul.plain li{margin-bottom:6px;max-width:72ch}
footer{padding-block:24px;font-size:12.5px;color:var(--fg-2)}
</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="eyebrow">Synapse Solutions · Quadrion AI · mark refinement · 7 Oct 2026</span><button class="theme-btn" id="theme-btn" type="button">Theme: auto</button></div></header>
<main class="wrap">
<section>
  <h1>Four layers, refined</h1>
  <p>Your pick: Four layers, Mission colours, Archivo Expanded 700. The mark's one weakness is that it sits close to the generic "layers" icon that most apps use. Here is your version beside three refinements that keep the idea and give it a silhouette Quadrion can own.</p>
  <div class="cmp">
    <figure>${generic(M.ink, 48)}<figcaption>Generic layers icon</figcaption></figure>
    ${VARIANTS.map((k) => `<figure>${symbol(k, M, 48)}<figcaption>${esc(MARKS[k].title)}</figcaption></figure>`).join('')}
  </div>
  <div class="grid">${VARIANTS.map(card).join('')}</div>
</section>
<section>
  <h2>Recommended: Time steps</h2>
  <p>The plates step forward as they rise, so the stack reads as captures moving through time. That idea is the reason for the name, and the leaning silhouette is the clearest break from the generic icon at every size. Shown here in the app window, the splash screen and a report cover.</p>
  <div class="ctx">
    <figure class="win"><div class="tb">${appIcon(REC, M, 16)}<span style="${WM};font-size:9px">QUADRION</span><small>Tank T-101 · synthetic sample</small></div><div class="wbody"><div class="rail">${symbol(REC, M, 18)}<i></i><i></i><i></i></div><div style="flex:1;min-width:0">${stage()}</div></div></figure>
    <figure class="splash">${symbol(REC, M, 64)}${word(M.ink, 36, M.acc)}<div style="font-size:13px;opacity:.85">Four dimensions. One view.</div><small>Version 0.9.0 · Synapse Solutions</small></figure>
    <figure class="report"><div style="display:flex;align-items:center;gap:6px">${symbol(REC, { ink: M.inkL, acc: M.accL }, 20)}<span style="${WM};font-size:8px;opacity:1">QUADRION</span></div><div class="bar"></div><b>Asset review</b><span>Tank T-101 · synthetic sample</span><span style="font-family:var(--f-mono);margin-top:8px">October 2026</span></figure>
  </div>
</section>
<section>
  <h2>What happens next</h2>
  <ul class="plain">
    <li>You confirm the mark: your original Four layers, or one of the refinements. (Shared axis can read as a tree or a caduceus, so it is the weakest of the three.)</li>
    <li>I outline the QUADRION AI wordmark as vector paths, so it needs no font, and cut the final icon set: Windows .ico, macOS .icns, PNGs from 16 to 1024 px, favicon and installer art.</li>
    <li>Renaming the app from Stratlas touches the app ID, the data folder, the link scheme and the Microsoft Store listing, so I will bring you a short plan for that before changing any code.</li>
  </ul>
  <p style="font-size:12.5px;color:var(--fg-2)">Files: final/assets/ holds each variant as dark, light and mono SVG, plus a 1024 px app icon.</p>
</section>
</main>
<footer><div class="wrap">Synapse Solutions · Quadrion AI · all scene and report content is synthetic.</div></footer>
<script>
(function(){var b=document.getElementById('theme-btn'),m=['auto','dark','light'],i=0;try{var s=localStorage.getItem('qf-theme');if(s&&m.indexOf(s)>=0)i=m.indexOf(s);}catch(e){}
function a(){var x=m[i];if(x==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',x);b.textContent='Theme: '+x;}a();
b.addEventListener('click',function(){i=(i+1)%m.length;a();try{localStorage.setItem('qf-theme',m[i]);}catch(e){}});})();
</script>
</body>
</html>
`;
writeFileSync(join(out, 'index.html'), html);
console.log('wrote final/index.html', html.length);
