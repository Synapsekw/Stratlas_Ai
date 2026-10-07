// Renders in-context mockups for each finalist with headless Chromium (Playwright).
// No windows are shown. Output: ../assets/<slug>/mockups/*.png and ../assets/compare-*.png
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { FINALISTS, PAL, C, symbolInner, wordmarkGroup, lockupSVG } from './marks.mjs';

const HERE = import.meta.dirname;
const ASSETS = path.resolve(HERE, '..', 'assets');
const TMP = path.resolve(HERE, '.render');
fs.mkdirSync(TMP, { recursive: true });
const FONT = (p) => pathToFileURL(path.resolve(HERE, '../../../../node_modules/@fontsource', p)).href;

const fontCSS = `
@font-face{font-family:'IBM Plex Sans';font-weight:400;src:url(${FONT('ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2')})}
@font-face{font-family:'IBM Plex Sans';font-weight:500;src:url(${FONT('ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2')})}
@font-face{font-family:'IBM Plex Sans';font-weight:600;src:url(${FONT('ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2')})}
@font-face{font-family:'IBM Plex Mono';font-weight:400;src:url(${FONT('ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2')})}
@font-face{font-family:'IBM Plex Mono';font-weight:500;src:url(${FONT('ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2')})}
@font-face{font-family:'IBM Plex Sans Condensed';font-weight:500;src:url(${FONT('ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-500-normal.woff2')})}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Sans','Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:'IBM Plex Mono',Consolas,monospace}
:root{--bg0:${C.bg0};--bg1:${C.bg1};--bg2:${C.bg2};--bg3:${C.bg3};--chrome:${C.chrome};--line:${C.line};--line-strong:${C.lineStrong};
--fg0:${C.fg0};--fg1:${C.fg1};--fg2:${C.fg2};--fg3:${C.fg3};--acc:${C.acc};--acc-ink:${C.accInk};--s5:${C.s5};--s4:${C.s4};--s3:${C.s3}}`;

const sym = (key, pal, px, small = px <= 32) => `<svg width="${px}" height="${px}" viewBox="0 0 64 64">${symbolInner(key, pal, small)}</svg>`;
const wm = (word, color, cap) => { const w = wordmarkGroup(word, color, cap); return `<svg width="${w.width.toFixed(1)}" height="${w.height.toFixed(1)}" viewBox="0 0 ${w.width.toFixed(2)} ${w.height.toFixed(2)}">${w.svg}</svg>`; };
const icon = (slug, s) => `<img src="${pathToFileURL(path.join(ASSETS, slug, 'png', `icon-${s}.png`)).href}" width="${s}" height="${s}" style="display:block">`;
const iconAt = (slug, src, px) => `<img src="${pathToFileURL(path.join(ASSETS, slug, 'png', `icon-${src}.png`)).href}" width="${px}" height="${px}" style="display:block">`;

// neutral placeholder app icon (other apps); simple glyphs only
const GLYPHS = [
  '<rect x="18" y="20" width="28" height="22" rx="3" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M18 28h28" stroke="#cfd5dc" stroke-width="3"/>',
  '<circle cx="32" cy="32" r="13" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M19 32h26M32 19c-6 7-6 19 0 26M32 19c6 7 6 19 0 26" stroke="#cfd5dc" stroke-width="2.4" fill="none"/>',
  '<rect x="17" y="22" width="30" height="20" rx="2" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M17 23l15 11 15-11" stroke="#cfd5dc" stroke-width="3" fill="none"/>',
  '<circle cx="32" cy="32" r="7" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M32 15v6M32 43v6M15 32h6M43 32h6M20 20l4 4M40 40l4 4M44 20l-4 4M24 40l-4 4" stroke="#cfd5dc" stroke-width="3"/>',
  '<path d="M18 22l9 8-9 8M30 42h16" stroke="#cfd5dc" stroke-width="3" fill="none"/>',
  '<rect x="17" y="19" width="30" height="26" rx="2" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M17 38l9-8 7 6 5-4 9 8" stroke="#cfd5dc" stroke-width="3" fill="none"/>',
  '<path d="M22 16h16l6 6v26H22z" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M27 30h12M27 36h12" stroke="#cfd5dc" stroke-width="3"/>',
  '<rect x="20" y="16" width="24" height="32" rx="2" fill="none" stroke="#cfd5dc" stroke-width="3"/><path d="M25 23h14M25 31h4M31 31h4M25 38h4M31 38h4" stroke="#cfd5dc" stroke-width="3"/>',
];
const HUES = ['#3b4654', '#34465c', '#4a3d52', '#3d4a3f', '#2f3b46', '#4d4436', '#38404a', '#463a3a'];
const other = (i, px, r = 0.22) => `<svg width="${px}" height="${px}" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="${60 * r}" fill="${HUES[i % 8]}"/>${GLYPHS[i % 8]}</svg>`;

// synthetic operating-picture scene (top-down map style). No real site.
function scene(w, h, { dark = true, seed = 1 } = {}) {
  const bg = dark ? '#0f151b' : '#e9edf1', ln = dark ? '#1c252e' : '#d3dae1', ct = dark ? '#18212a' : '#dbe1e7';
  const ink = dark ? C.fg1 : '#3a434d', acc = dark ? C.acc : C.accLight;
  let s = `<rect width="${w}" height="${h}" fill="${bg}"/>`;
  for (let x = 0; x < w; x += 40) s += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${ln}" stroke-width="1"/>`;
  for (let y = 0; y < h; y += 40) s += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${ln}" stroke-width="1"/>`;
  for (let k = 0; k < 9; k++) {
    let d = '';
    for (let x = -20; x <= w + 20; x += 20) {
      const y = h * 0.12 + k * h * 0.11 + Math.sin((x + seed * 90) / 140 + k) * 18 + Math.sin(x / 57 + k * 2) * 6;
      d += (d ? ' L' : 'M') + `${x} ${y.toFixed(1)}`;
    }
    s += `<path d="${d}" fill="none" stroke="${ct}" stroke-width="1.4"/>`;
  }
  // road + pads
  s += `<path d="M0 ${h * 0.78} L${w * 0.35} ${h * 0.7} L${w} ${h * 0.74}" stroke="${dark ? '#26313b' : '#c3ccd5'}" stroke-width="14" fill="none"/>`;
  const tanks = [[0.22, 0.38, 38], [0.34, 0.36, 30], [0.27, 0.56, 34], [0.62, 0.42, 44], [0.75, 0.3, 28], [0.72, 0.58, 32]];
  for (const [tx, ty, r] of tanks) {
    const sx = ((tx + 0.17 * (seed - 1)) % 0.84) + 0.08; const cx = sx * w, cy = ty * h, rr = r * Math.min(w, h) / 600;
    s += `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${dark ? '#1a232c' : '#f7f9fb'}" stroke="${ink}" stroke-opacity=".55" stroke-width="1.3"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="${rr * 0.62}" fill="none" stroke="${ink}" stroke-opacity=".25"/>`;
  }
  s += `<rect x="${w * 0.45}" y="${h * 0.2}" width="${w * 0.08}" height="${h * 0.12}" fill="none" stroke="${ink}" stroke-opacity=".45"/>`;
  s += `<rect x="${w * 0.47}" y="${h * 0.52}" width="${w * 0.05}" height="${h * 0.1}" fill="none" stroke="${ink}" stroke-opacity=".45"/>`;
  // flight path + drone
  const fp = [[0.08, 0.88], [0.18, 0.66], [0.3, 0.46], [0.46, 0.38], [0.58, 0.34], [0.7, 0.44], [0.84, 0.5]];
  s += `<polyline points="${fp.map(([a, b]) => `${a * w},${b * h}`).join(' ')}" fill="none" stroke="${acc}" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  const [dx, dy] = [0.58 * w, 0.34 * h];
  s += `<path d="M${dx} ${dy - 8} L${dx + 8} ${dy} L${dx} ${dy + 8} L${dx - 8} ${dy} Z" fill="${acc}"/>`;
  s += `<path d="M${dx} ${dy} L${dx + 60} ${dy + 70} L${dx - 30} ${dy + 80} Z" fill="${acc}" fill-opacity=".10" stroke="${acc}" stroke-opacity=".5"/>`;
  // callouts
  const call = (x, y, lx, ly, label, sev) => {
    ly = Math.max(16, Math.min(h - 16, ly)); lx = Math.min(w - label.length * 7 - 26, lx);
    const col = sev === 5 ? C.s5 : sev === 4 ? C.s4 : C.s3;
    return `<circle cx="${x}" cy="${y}" r="4" fill="${col}"/><polyline points="${x},${y} ${lx},${ly} ${lx + 8},${ly}" fill="none" stroke="${ink}" stroke-opacity=".7"/>`
      + `<rect x="${lx + 8}" y="${ly - 11}" width="${label.length * 7 + 14}" height="22" fill="${dark ? '#0b0f14' : '#ffffff'}" fill-opacity=".9" stroke="${col}"/>`
      + `<text x="${lx + 15}" y="${ly + 4}" font-family="IBM Plex Mono,monospace" font-size="11" fill="${dark ? C.fg0 : '#15181d'}">${label}</text>`;
  };
  s += call(0.62 * w + 10, 0.42 * h - 20, 0.62 * w + 70, 0.42 * h - 70, 'F-07  S5  shell', 5);
  s += call(0.27 * w + 12, 0.56 * h, 0.27 * w - 30, 0.56 * h + 60, 'F-12  S4  nozzle', 4);
  s += call(0.75 * w - 10, 0.3 * h + 8, 0.75 * w + 40, 0.3 * h + 70, 'F-03  S3  coating', 3);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">${s}</svg>`;
}

const pages = {
  taskbar: (fz) => ({ w: 1280, h: 720, html: `
<div style="position:relative;width:1280px;height:720px;background:radial-gradient(120% 90% at 30% 20%,#25324a,#0e141c 70%);overflow:hidden">
 <div style="position:absolute;left:320px;top:150px;width:640px;height:470px;border-radius:10px;background:rgba(32,36,42,.92);border:1px solid rgba(255,255,255,.08);box-shadow:0 20px 60px rgba(0,0,0,.5);padding:28px 32px;color:#e8eaee">
  <div style="height:36px;border-radius:18px;background:#1b1f25;border:1px solid #3a4049;display:flex;align-items:center;padding:0 16px;color:#8b94a0;font-size:13px">Search for apps, settings and documents</div>
  <div style="display:flex;justify-content:space-between;margin:24px 4px 14px;font-size:13px;font-weight:600"><span>Pinned</span><span style="font-weight:400;color:#aab2bd">All ›</span></div>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);row-gap:20px">
   ${[0, 1, 2, 'me', 3, 4, 5, 6, 7, 0, 1, 2].map((v, i) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0;border-radius:6px;${v === 'me' ? 'background:rgba(255,255,255,.07)' : ''}">${v === 'me' ? iconAt(fz.slug, 48, 40) : other(+v, 40)}<span style="font-size:12px;color:#d9dde3">${v === 'me' ? fz.display : ['Files', 'Browser', 'Mail', 'Settings', 'Terminal', 'Photos', 'Notes', 'Calculator'][+v]}</span></div>`).join('')}
  </div>
  <div style="margin:26px 4px 12px;font-size:13px;font-weight:600">Recommended</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
   <div style="display:flex;gap:12px;align-items:center;padding:8px;border-radius:6px;background:rgba(255,255,255,.05)">${iconAt(fz.slug, 32, 32)}<div><div style="font-size:12px">Sample Terminal A.${fz.slug.slice(0, 3)}pkg</div><div style="font-size:11px;color:#9aa3ad">Encrypted package · 2h ago</div></div></div>
   <div style="display:flex;gap:12px;align-items:center;padding:8px;border-radius:6px">${other(6, 32)}<div><div style="font-size:12px">Survey notes</div><div style="font-size:11px;color:#9aa3ad">Yesterday</div></div></div>
  </div>
 </div>
 <div style="position:absolute;left:0;bottom:0;width:1280px;height:48px;background:rgba(28,32,38,.94);border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;gap:6px">
  ${[-1, 1, 0, 'me', 4, 2].map((v) => v === -1
    ? `<div style="width:40px;height:40px;border-radius:4px;display:grid;place-items:center;background:rgba(255,255,255,.08)"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="#cfd5dc" stroke-width="2"/></svg></div>`
    : `<div style="position:relative;width:40px;height:40px;border-radius:4px;display:grid;place-items:center;${v === 'me' ? 'background:rgba(255,255,255,.1)' : ''}">${v === 'me' ? icon(fz.slug, 24) : other(+v, 24)}${v === 'me' ? '<div style="position:absolute;bottom:2px;left:13px;width:14px;height:3px;border-radius:2px;background:#7fb8ff"></div>' : ''}</div>`).join('')}
  <div style="position:absolute;right:16px;color:#e8eaee;font-size:12px;text-align:right;line-height:16px">09:41<br><span style="color:#aab2bd">05/10/2026</span></div>
 </div>
 <div style="position:absolute;left:663px;bottom:56px;padding:6px 10px;border-radius:4px;background:#2b3038;border:1px solid #444b55;color:#e8eaee;font-size:12px;transform:translateX(-50%) translateX(${-0}px)">${fz.display}</div>
</div>` }),

  store: (fz) => ({ w: 1280, h: 720, html: `
<div style="width:1280px;height:720px;background:#1c1f24;color:#eceef1;padding:40px 56px">
 <div style="display:flex;gap:32px;align-items:flex-start">
  <div style="width:180px;height:180px;border-radius:8px;background:#272b31;display:grid;place-items:center">${icon(fz.slug, 128)}</div>
  <div style="flex:1">
   <div style="font-size:30px;font-weight:600;letter-spacing:-.01em">${fz.display}</div>
   <div style="margin-top:6px;font-size:14px;color:#8fc2ff">Synapse Solutions</div>
   <div style="margin-top:4px;font-size:13px;color:#a7aeb7">Business · Productivity</div>
   <div style="margin-top:22px;display:flex;gap:12px;align-items:center"><div style="padding:9px 34px;border-radius:4px;background:#4a90e2;color:#fff;font-weight:600;font-size:14px">Get</div><div style="font-size:12px;color:#a7aeb7">Desktop app · Windows 10 and 11 · works offline</div></div>
   <p style="margin-top:22px;max-width:640px;font-size:14px;line-height:21px;color:#cfd4da">Offline-first command center for physical assets and sites. Fuse drone video, 3D models, point clouds, orthomosaics and maps into one scene; manage thousands of inspection findings; ask the built-in agent; ship encrypted single-file packages to clients.</p>
  </div>
 </div>
 <div style="margin-top:34px;font-size:15px;font-weight:600">Screenshots</div>
 <div style="margin-top:12px;display:flex;gap:14px">
  ${[1, 2, 3].map((sd) => `<div style="border-radius:6px;overflow:hidden;border:1px solid #2d3239">${scene(370, 208, { seed: sd, dark: sd !== 2 })}</div>`).join('')}
 </div>
 <div style="margin-top:22px;display:flex;gap:10px">
  ${['Store tile 300', 'List 150', 'Search 48'].map((t, i) => `<div style="display:flex;gap:10px;align-items:center;padding:10px 14px;background:#25292f;border-radius:6px">${iconAt(fz.slug, [256, 128, 48][i], [56, 40, 24][i])}<span style="font-size:12px;color:#a7aeb7">${t}</span></div>`).join('')}
 </div>
</div>` }),

  dock: (fz) => ({ w: 1280, h: 400, html: `
<div style="position:relative;width:1280px;height:400px;background:linear-gradient(160deg,#3b4a5e,#141a22 60%,#0b0f14);overflow:hidden">
 <div style="position:absolute;top:0;left:0;right:0;height:26px;background:rgba(20,24,30,.55);display:flex;align-items:center;gap:20px;padding:0 18px;color:#e7eaee;font-size:13px"><b style="font-weight:600">${fz.display}</b><span>File</span><span>Edit</span><span>View</span><span>Project</span><span>Window</span><span>Help</span></div>
 <div style="position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:flex-end;padding:8px 12px;border-radius:22px;background:rgba(60,66,76,.45);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(20px)">
  ${[0, 1, 2, 3, 'me', 4, 5, 6, 7].map((v) => `<div style="position:relative">${v === 'me' ? `<div style="position:absolute;bottom:84px;left:50%;transform:translateX(-50%);padding:4px 10px;border-radius:6px;background:rgba(40,44,52,.9);color:#eef0f3;font-size:13px;white-space:nowrap">${fz.display}</div>` + iconAt(fz.slug, 256, 72) : other(+v, 64, 0.23)}${v === 'me' || v === 1 ? '<div style="position:absolute;bottom:-6px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:2px;background:#e7eaee"></div>' : ''}</div>`).join('')}
 </div>
</div>` }),

  titlebar: (fz) => {
    const pal = PAL.dark;
    const bar = (collapsed) => `
<div style="display:flex;height:40px;background:var(--chrome);border-bottom:1px solid var(--line)">
 <div style="width:${collapsed ? 52 : 252}px;display:flex;align-items:center;gap:10px;padding:0 ${collapsed ? 14 : 14}px;border-right:1px solid var(--line)">${sym(fz.primary, pal, 24, true)}${collapsed ? '' : wm(fz.word, C.fg0, 10)}</div>
 <div style="flex:1;display:flex;align-items:center;gap:16px;padding:0 14px">
  <div style="font-size:13px;color:var(--fg2)">Sample Estate <span style="color:var(--fg3)">/</span> Terminal A <span style="color:var(--fg3)">/</span> <span style="color:var(--fg0)">3D</span></div>
  <div style="margin-left:auto;width:340px;height:26px;border:1px solid var(--line);border-radius:4px;background:var(--bg1);display:flex;align-items:center;padding:0 10px;font-size:12px;color:var(--fg3)">Search or ask the agent<span class="mono" style="margin-left:auto;font-size:11px;color:var(--fg3)">Ctrl K</span></div>
  <div style="display:flex;gap:6px;margin-left:auto">
   <span class="mono" style="font-size:11px;padding:3px 8px;border:1px solid var(--line);border-radius:2px;color:var(--fg1)"><span style="display:inline-block;width:6px;height:6px;border-radius:3px;background:var(--acc);margin-right:6px"></span>OFFLINE</span>
   <span class="mono" style="font-size:11px;padding:3px 8px;border:1px solid var(--line);border-radius:2px;color:var(--fg2)">CLOUD AI · OFF</span>
  </div>
  <div style="display:flex;gap:18px;color:var(--fg2);font-size:14px;padding-left:12px"><span>&#8211;</span><span>&#9633;</span><span>&#10005;</span></div>
 </div>
</div>`;
    return { w: 1440, h: 470, html: `
<div style="width:1440px;height:470px;background:var(--bg0);color:var(--fg0)">
 ${bar(false)}
 <div style="display:flex;height:170px">
  <div style="width:252px;background:var(--chrome);border-right:1px solid var(--line);padding:12px 14px;font-size:13px;color:var(--fg1);line-height:30px">
   <div style="color:var(--fg0);background:var(--bg3);margin:0 -8px;padding:0 8px;border-radius:4px">Workspace</div><div>Findings <span class="mono" style="float:right;color:var(--fg3);font-size:11px">2,418</span></div><div>Datasets</div><div>Packages</div><div>Agent</div>
  </div>
  <div style="flex:1;overflow:hidden">${scene(1188, 170, { seed: 2 })}</div>
 </div>
 <div style="height:20px"></div>
 ${bar(true)}
 <div style="display:flex;height:180px">
  <div style="width:52px;background:var(--chrome);border-right:1px solid var(--line)"></div>
  <div style="flex:1;overflow:hidden">${scene(1388, 180, { seed: 4 })}</div>
 </div>
</div>` };
  },

  splash: (fz) => ({ w: 960, h: 600, html: `
<div style="position:relative;width:960px;height:600px;background:radial-gradient(90% 80% at 50% 40%,${C.bg2},${C.ground} 70%);color:var(--fg0);overflow:hidden">
 <div style="position:absolute;inset:0;opacity:.35">${scene(960, 600, { seed: 5 }).replace('<rect width="960" height="600" fill="#0f151b"/>', '')}</div>
 <div style="position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 45%,rgba(11,15,20,.92),rgba(11,15,20,.55))"></div>
 <div style="position:absolute;left:0;right:0;top:190px;display:flex;justify-content:center">${lockupSVG(fz.primary, fz.word, PAL.dark, { capPx: 34, arabic: fz.arabic })}</div>
 <div style="position:absolute;left:330px;right:330px;top:380px;height:2px;background:var(--line)"><div style="width:62%;height:2px;background:var(--acc)"></div></div>
 <div class="mono" style="position:absolute;left:0;right:0;top:396px;text-align:center;font-size:11px;color:var(--fg2);letter-spacing:.04em">OPENING PROJECT · INDEXING 2,418 FINDINGS</div>
 <div class="mono" style="position:absolute;left:24px;bottom:20px;font-size:11px;color:var(--fg3)">v0.9.0 · OFFLINE · AES-256 PACKAGES</div>
 <div style="position:absolute;right:24px;bottom:18px;font-size:12px;color:var(--fg3)">Synapse Solutions</div>
</div>` }),

  hero: (fz) => ({ w: 1440, h: 860, html: `
<div style="width:1440px;height:860px;background:${C.ground};color:var(--fg0);overflow:hidden;position:relative">
 <div style="height:72px;display:flex;align-items:center;padding:0 64px;border-bottom:1px solid var(--line)">
  <div style="display:flex;align-items:center;gap:12px">${sym(fz.primary, PAL.dark, 30, false)}${wm(fz.word, C.fg0, 13)}</div>
  <div style="display:flex;gap:32px;margin-left:64px;font-size:14px;color:var(--fg1)"><span>Product</span><span>Industries</span><span>Security</span><span>Company</span></div>
  <div style="margin-left:auto;padding:9px 16px;border:1px solid var(--line-strong);border-radius:4px;font-size:14px">Request a demo</div>
 </div>
 <div style="padding:84px 64px 0;display:grid;grid-template-columns:560px 1fr;gap:56px">
  <div>
   <div class="mono" style="font-size:12px;color:var(--acc);letter-spacing:.08em">OFFLINE-FIRST · ENCRYPTED · AGENT IN EVERY VIEW</div>
   <h1 style="margin-top:20px;font-size:54px;line-height:60px;font-weight:600;letter-spacing:-.02em">One operating picture for every asset you own.</h1>
   <p style="margin-top:22px;font-size:18px;line-height:28px;color:var(--fg1)">Drone video, 3D models, point clouds and maps fused in one scene. Thousands of findings, one source of truth, and a package your client can open anywhere.</p>
   <div style="margin-top:34px;display:flex;gap:12px"><div style="padding:12px 20px;background:var(--acc);color:var(--acc-ink);font-weight:600;border-radius:4px">Request a demo</div><div style="padding:12px 20px;border:1px solid var(--line-strong);border-radius:4px">See how it works</div></div>
  </div>
  <div style="border:1px solid var(--line);border-radius:6px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.45)">
   <div style="height:28px;background:var(--chrome);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;padding:0 10px">${sym(fz.primary, PAL.dark, 14, true)}<span style="font-size:11px;color:var(--fg2)">Sample Estate / Terminal A / Map</span></div>
   ${scene(760, 470, { seed: 3 })}
  </div>
 </div>
</div>` }),

  report: (fz) => ({ w: 794, h: 1123, html: `
<div style="position:relative;width:794px;height:1123px;background:#fff;color:#15181d;overflow:hidden">
 <div style="padding:56px 64px 0;display:flex;align-items:center;justify-content:space-between">
  ${lockupSVG(fz.primary, fz.word, PAL.light, { capPx: 16 })}
  <div class="mono" style="font-size:10px;color:#5b6570;text-align:right;line-height:15px">CONFIDENTIAL<br>SYN-2026-0001</div>
 </div>
 <div style="margin:40px 64px 0;border-top:2px solid #15181d"></div>
 <div style="padding:36px 64px 0">
  <div class="mono" style="font-size:11px;letter-spacing:.1em;color:${C.accLight}">ASSET INSPECTION REPORT</div>
  <div style="margin-top:14px;font-size:40px;line-height:46px;font-weight:600;letter-spacing:-.015em">Tank Farm North<br>External shell survey</div>
  <div style="margin-top:12px;font-size:15px;color:#4b5560">Sample Estate · Terminal A · synthetic demonstration data</div>
  <div dir="rtl" style="margin-top:8px;font-size:15px;color:#4b5560;font-family:'Segoe UI',Tahoma,sans-serif;text-align:left">تقرير فحص الأصول</div>
 </div>
 <div style="margin:36px 64px 0;border:1px solid #d5dbe2">${scene(664, 360, { dark: false, seed: 6 })}</div>
 <div style="margin:28px 64px 0;display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid #d5dbe2">
  ${[['Survey date', '05 Oct 2026'], ['Findings', '38'], ['Critical (S5)', '2'], ['Package', 'SYN-0001.pkg']].map(([k, v]) => `<div style="padding:12px 0"><div style="font-size:10px;color:#6b7580;text-transform:uppercase;letter-spacing:.06em">${k}</div><div class="mono" style="margin-top:4px;font-size:14px">${v}</div></div>`).join('')}
 </div>
 <div style="position:absolute;left:64px;right:64px;bottom:40px;display:flex;justify-content:space-between;font-size:10px;color:#6b7580;border-top:1px solid #d5dbe2;padding-top:10px"><span>Prepared by Synapse Solutions</span><span class="mono">Page 1 of 64</span></div>
</div>` }),
};

// rough neutral silhouettes of reference brands (not their artwork) for the distinctness check
const REFS = [
  { name: 'Palantir', note: 'ring above a curved base', svg: '<circle cx="32" cy="24" r="12" fill="none" stroke="#8a929c" stroke-width="6"/><path d="M12 44 Q32 58 52 44" fill="none" stroke="#8a929c" stroke-width="6"/>' },
  { name: 'Anduril', note: 'angular A-form emblem', svg: '<path d="M32 10 L54 54 H42 L32 33 L22 54 H10 Z" fill="#8a929c"/>' },
  { name: 'Esri', note: 'globe with arcs', svg: '<circle cx="32" cy="32" r="22" fill="none" stroke="#8a929c" stroke-width="5"/><path d="M14 26 Q32 38 50 22M16 42 Q34 50 52 38" fill="none" stroke="#8a929c" stroke-width="4"/>' },
  { name: 'DJI', note: 'short heavy lowercase wordmark', svg: '<rect x="8" y="22" width="14" height="24" rx="6" fill="#8a929c"/><rect x="26" y="22" width="9" height="30" rx="3" fill="#8a929c"/><rect x="39" y="22" width="9" height="24" rx="3" fill="#8a929c"/><rect x="19" y="12" width="5" height="30" fill="#8a929c"/>' },
  { name: 'Pix4D', note: 'wordmark with pixel blocks', svg: '<rect x="10" y="18" width="12" height="12" fill="#8a929c"/><rect x="24" y="18" width="12" height="12" fill="#8a929c" opacity=".6"/><rect x="10" y="32" width="12" height="12" fill="#8a929c" opacity=".6"/><rect x="38" y="24" width="18" height="6" fill="#8a929c"/><rect x="38" y="34" width="12" height="6" fill="#8a929c"/>' },
];

function comparePage() {
  const cell = (inner, label, sub, px) => `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;width:140px"><div style="width:${px}px;height:${px}px">${inner}</div><div style="font-size:12px;color:${C.fg0}">${label}</div><div style="font-size:10px;color:${C.fg3};text-align:center">${sub}</div></div>`;
  const row = (px) => `<div style="display:flex;gap:18px;align-items:flex-end;padding:22px 24px;border-bottom:1px solid ${C.line}">
   ${FINALISTS.map((fz) => cell(`<svg width="${px}" height="${px}" viewBox="0 0 64 64">${symbolInner(fz.primary, PAL.dark, px <= 32)}</svg>`, fz.display, 'finalist', px)).join('')}
   <div style="width:1px;align-self:stretch;background:${C.line}"></div>
   ${REFS.map((r) => cell(`<svg width="${px}" height="${px}" viewBox="0 0 64 64">${r.svg}</svg>`, r.name, 'rough silhouette: ' + r.note, px)).join('')}
  </div>`;
  return { w: 1440, h: 520, html: `<div style="width:1440px;height:520px;background:${C.ground};font-family:'IBM Plex Sans'">${row(96)}${row(32)}${row(16)}</div>` };
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ deviceScaleFactor: 1 });
const page = await ctx.newPage();
async function shot(def, file) {
  const htmlPath = path.join(TMP, path.basename(file).replace('.png', '.html'));
  fs.writeFileSync(htmlPath, `<!doctype html><meta charset="utf-8"><style>${fontCSS}</style><body style="width:${def.w}px;height:${def.h}px">${def.html}</body>`);
  await page.setViewportSize({ width: def.w, height: def.h });
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(80);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: def.w, height: def.h } });
}

const only = process.argv[2];
for (const fz of FINALISTS) {
  if (only && only !== fz.slug && only !== 'compare') continue;
  for (const [k, fn] of Object.entries(pages)) {
    await shot(fn(fz), path.join(ASSETS, fz.slug, 'mockups', `${k}.png`));
  }
  console.log('mockups', fz.slug);
}
await shot(comparePage(), path.join(ASSETS, 'compare.png'));
await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('done');
