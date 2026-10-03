import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const A = '../../assets/';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = (id, cls = '') => `<svg class="ic ${cls}"><use href="#i-${id}"/></svg>`;
const store = {
  get(k, d) { try { const v = localStorage.getItem('stratlas.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('stratlas.' + k, JSON.stringify(v)); } catch {} }
};
const raf = f => (document.hidden ? setTimeout(f, 40) : requestAnimationFrame(f));
const fmt = (n, d = 1) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// OKLCH to linear sRGB (THREE.Color does not parse oklch strings)
function OK(str) {
  const m = str.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const L = +m[1], C = +m[2], h = +m[3] * Math.PI / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = v => Math.max(0, Math.min(1, v));
  return new THREE.Color().setRGB(c(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s), c(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s), c(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s), THREE.LinearSRGBColorSpace);
}
const lerp = (a, b, t) => a + (b - a) * t;

/* =========================================================== DATA */
const PROJECTS = [
  { id: 'alzour', name: 'Al-Zour LNG terminal', org: 'KIPIC', site: 'Al-Zour, Kuwait', type: 'Plant fusion', date: '21 Feb 2023', cap: '25 clips · 842 M pts', cap2: '909 nodes · 3 panos', size: '48.6 GB', off: 1, thumb: 'alzour/clip_dji0789_tanks_poster.jpg', dur: '3:12:40', layers: [1, 1, 1, 1, 1, 1], ll: [48.381, 28.716], opened: '2 h ago' },
  { id: 'hcl', name: 'HCl Tank 710-D-130335', org: 'KOC', site: 'Mina Al-Ahmadi, Kuwait', type: 'Tank inspection', date: '22 Nov 2023', cap: '10 flights · 1.4 M pts', cap2: '11 findings · S3 to S5', size: '6.2 GB', off: 1, thumb: 'hcl/clip_f110_external_poster.jpg', dur: '1:24:10', layers: [1, 1, 1, 1, 1, 1], ll: [48.128, 29.071], opened: 'Today 11:48' },
  { id: 'ebsm', name: 'EBSM flare stack', org: 'EQUATE', site: 'Shuaiba, Kuwait', type: 'Stack inspection', date: '24 Jan 2019', cap: '80 m · 299 photos', cap2: '78 findings', size: '9.8 GB', off: 1, thumb: 'ebsm/p271.jpg', layers: [1, 0, 0, 0, 1, 1], ll: [48.158, 28.985], opened: 'Today 09:30' },
  { id: 'damac', name: 'DAMAC Hills tower facade', org: 'DAMAC', site: 'Dubai, UAE', type: 'Facade inspection', date: '5 Jun 2024', cap: '1,182 photos', cap2: '656 defects · 206 p report', size: '21.4 GB', off: 0.64, thumb: 'damac/p0190.jpg', layers: [1, 0, 0, 0, 1, 1], ll: [55.248, 25.028], opened: 'Yesterday' },
  { id: 'masafi', name: 'Masafi stockpile yard', org: 'Masafi', site: 'Sulaibiya, Kuwait', type: 'Volumetrics', date: '10 Jan 2021', cap: '19 piles · 2 surveys', cap2: '31 Dec 2020 vs 10 Jan 2021', size: '3.1 GB', off: 1, thumb: null, layers: [1, 1, 1, 0, 0, 1], ll: [47.842, 29.262], opened: 'Yesterday' },
  { id: 'ring', name: '1st Ring Road survey', org: 'MPW', site: 'Kuwait City', type: 'Road survey', date: '3 Mar 2025', cap: 'Ortho 1.25 cm GSD', cap2: 'PCI per ASTM D6433 · 6.4 km', size: '14.7 GB', off: 0, thumb: null, layers: [0, 0, 1, 0, 1, 1], ll: [47.982, 29.372], opened: '12 Sep' }
];
const LAYER_ICONS = ['cube', 'points', 'raster', 'video', 'photo', 'annot'];
const LAYER_NAMES = ['Models', 'Point clouds', 'Maps and rasters', 'Video', 'Photos', 'Annotations'];

const TREES = {
  alzour: [
    { icon: 'cube', name: 'Models', n: '1', open: true, items: [
      { lbl: 'Al-Zour plant model', meta: '909', tw: 'down', d: 0, icon: 'cube' },
      ...[['10', 'Jetty and berths', 145], ['20', 'LNG tanks', 168, 1], ['30', 'HP LNG process', 53], ['40', 'BOG handling', 26], ['50', 'Send-out and sea water', 110], ['60', 'Flare', 10], ['70', 'Utilities', 96], ['80', 'Buildings', 12], ['', 'Site pipe racks', 32], ['', 'Roads, fences, paving', 238], ['', 'Terrain and sea', 3, 0, 1], ['', 'Design vessels', 3, 0, 1]]
        .map(([c, l, n, sel, off]) => ({ lbl: (c ? c + '  ' : '') + l, meta: n, d: 1, tw: 'right', sel, off }))
    ] },
    { icon: 'points', name: 'Point clouds', n: '842 M', items: [] },
    { icon: 'raster', name: 'Maps and rasters', n: '3', items: [] },
    { icon: 'video', name: 'Video', n: '25', items: [] },
    { icon: 'photo', name: 'Photos', n: '3 panos', items: [] },
    { icon: 'annot', name: 'Annotations', n: '34', items: [] }
  ],
  hcl: [
    { icon: 'cube', name: 'Models', n: '1', open: true, items: [
      { lbl: 'Tank 710-D-130335', meta: '225', tw: 'down', d: 0, icon: 'cube' },
      ...[['Shell', 3], ['Roof', 4, 1], ['Bottom', 4], ['Rubber lining', 6], ['Nozzles N1 to N9', 92], ['Manholes', 12], ['Internals', 8], ['Attachments', 18], ['Foundation', 2]].map(([l, n, sel]) => ({ lbl: l, meta: n, d: 1, tw: 'right', sel }))
    ] },
    { icon: 'points', name: 'Point clouds', n: '2', open: true, items: [
      { lbl: 'LiDAR flight 101, shell', meta: '140 k', d: 0, icon: 'points' }, { lbl: 'LiDAR flight 108, roof', meta: '140 k', d: 0, icon: 'points' }] },
    { icon: 'raster', name: 'Maps and rasters', n: '1', items: [] },
    { icon: 'video', name: 'Video', n: '10', items: [] },
    { icon: 'photo', name: 'Photos', n: '6', items: [] },
    { icon: 'annot', name: 'Annotations', n: '12', items: [] }
  ]
};

/* =========================================================== SHELL */
const app = $('#app');
const tip = $('#tip');
function setCollapsed(c, animate = true) {
  if (!animate) app.style.transition = 'none';
  app.classList.toggle('sb-collapsed', c);
  $('#sbToggle').dataset.tip = c ? 'Expand sidebar' : 'Collapse sidebar';
  store.set('sb', c);
  if (!animate) requestAnimationFrame(() => (app.style.transition = ''));
}
setCollapsed(store.get('sb', false), false);
$('#sbToggle').addEventListener('click', () => setCollapsed(!app.classList.contains('sb-collapsed')));
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setCollapsed(!app.classList.contains('sb-collapsed')); }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && ['1', '2', '3', '4'].includes(e.key)) show(['home', 'fusion', 'inspect', 'settings'][+e.key - 1]);
  if (e.key === ' ' && cur === 'fusion') { e.preventDefault(); FUS.toggle(); }
});

// tooltips
let tipEl = null;
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]');
  if (!t || t === tipEl) return;
  const inSb = t.closest('.sb');
  const collapsed = app.classList.contains('sb-collapsed');
  if (inSb && !collapsed && !t.matches('.icbtn, .sb-toggle')) return;
  tipEl = t;
  const k = t.dataset.kbd ? `<span class="kbd">${t.dataset.kbd}</span>` : '';
  tip.innerHTML = t.dataset.tip + k;
  const r = t.getBoundingClientRect();
  tip.classList.add('show');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  if (inSb) { tip.style.left = r.right + 10 + 'px'; tip.style.top = r.top + r.height / 2 - th / 2 + 'px'; }
  else { tip.style.left = clamp(r.left + r.width / 2 - tw / 2, 8, innerWidth - tw - 8) + 'px'; tip.style.top = (r.bottom + 6 + th > innerHeight ? r.top - th - 6 : r.bottom + 6) + 'px'; }
});
document.addEventListener('mouseout', e => { if (tipEl && !tipEl.contains(e.relatedTarget)) { tip.classList.remove('show'); tipEl = null; } });

function renderTree(pid) {
  const groups = TREES[pid];
  $('#tree').innerHTML = groups.map((g, gi) => `
    <div class="tg ${g.open ? 'open' : ''}">
      <button class="tg-h" data-tip="${g.name} · ${g.n}">${ic(g.icon)}<span class="fade">${g.name}</span><span class="n fade">${g.n}</span><svg class="ic xs chev fade"><use href="#i-right"/></svg></button>
      <div class="tg-b">${g.items.map(it => `
        <div class="ti ${it.sel ? 'sel' : ''}" style="--d:${it.d}">
          ${it.tw ? `<span class="tw"><svg class="ic xs"><use href="#i-${it.tw}"/></svg></span>` : '<span class="tw"></span>'}
          ${it.icon ? ic(it.icon, 'xs') : ''}
          <span class="lbl">${it.lbl}</span><span class="meta">${it.meta}</span>
          <span class="vis ${it.off ? 'off' : ''}">${ic(it.off ? 'eyeoff' : 'eye', 'xs')}</span>
        </div>`).join('')}</div>
    </div>`).join('');
  $$('#tree .tg-h').forEach(h => h.addEventListener('click', () => h.parentElement.classList.toggle('open')));
}

const SCREENS = {
  home: { n: 1, proj: 'alzour', crumbs: ['Synapse Solutions', '<b>Projects</b>'], nav: 'home' },
  fusion: { n: 2, proj: 'alzour', crumbs: ['KIPIC', 'Al-Zour LNG terminal', '<b>Fusion workspace</b>'], nav: 'ws' },
  inspect: { n: 3, proj: 'hcl', crumbs: ['KOC', 'HCl Tank 710-D-130335', '<b>Inspection workspace</b>'], nav: 'ws' },
  settings: { n: 4, proj: 'alzour', crumbs: ['Settings', '<b>AI and agents</b>'], nav: 'settings' }
};
let cur = null, curProj = null;
function setProject(pid) {
  if (curProj === pid) return;
  curProj = pid;
  const p = PROJECTS.find(x => x.id === pid);
  $('#projName').textContent = p.name;
  $('#projSub').textContent = `${p.org} · ${p.site.split(', ').pop()}`;
  $('#projThumb').style.backgroundImage = `url(${A}${p.thumb})`;
  $('#navFlights') && ($('#navFlights').textContent = pid === 'hcl' ? '10' : '25');
  $('#navIssues').textContent = pid === 'hcl' ? '12' : '34';
  $('#sbCrs').textContent = pid === 'hcl' ? 'Frame · tank model, metres' : 'CRS · UTM 39N, plant grid';
  renderTree(pid);
}
function show(name) {
  if (!SCREENS[name]) name = 'home';
  if (cur === name) return;
  cur = name;
  const S = SCREENS[name];
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + name));
  $$('.nav-i').forEach(b => b.classList.toggle('on', b.dataset.go === S.nav));
  $$('.switcher .dots button').forEach(b => b.classList.toggle('on', b.dataset.scr === name));
  $('#capText').innerHTML = `<b>Option 2: Flight</b>, screen ${S.n} of 4`;
  $('#crumbs').innerHTML = S.crumbs.join('<span class="sep">/</span>');
  setProject(S.proj);
  try { history.replaceState(null, '', '#' + name); } catch {}
  FUS.active(name === 'fusion');
  INS.active(name === 'inspect');
  if (name === 'home') HOME.init();
  if (name === 'settings') SET.init();
}
$$('[data-go]').forEach(b => b.addEventListener('click', () => {
  const g = b.dataset.go;
  show(g === 'ws' ? (curProj === 'hcl' ? 'inspect' : 'fusion') : g);
}));
$$('.switcher [data-scr]').forEach(b => b.addEventListener('click', () => show(b.dataset.scr)));
$('#projSw').addEventListener('click', () => show(curProj === 'hcl' ? 'fusion' : 'inspect'));

/* swap tiles between slots */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-swap]');
  if (!b) return;
  const tile = b.closest('.tile'), slot = tile.parentElement;
  const root = tile.closest('.ws');
  const mainSlot = root.querySelector('.slot[data-slot="main"]');
  if (slot === mainSlot) return;
  const mainTile = mainSlot.querySelector('.tile');
  slot.appendChild(mainTile); mainSlot.appendChild(tile);
  [tile, mainTile].forEach(t => { t.classList.remove('swapped'); void t.offsetWidth; t.classList.add('swapped'); });
});

/* =========================================================== GEO (Natural Earth, public domain) */
let GEO = null;
const geoReady = fetch('option-2-geo.json').then(r => r.json()).then(g => (GEO = g)).catch(() => null);
function geoRender(el, view, opts = {}) {
  if (!GEO) return;
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;
  const latc = (view[1] + view[3]) / 2, k = Math.cos(latc * Math.PI / 180);
  const X0 = view[0] * k, X1 = view[2] * k, Y0 = -view[3], Y1 = -view[1];
  const s = Math.max(w / (X1 - X0), h / (Y1 - Y0));
  const ox = (w - (X1 - X0) * s) / 2, oy = (h - (Y1 - Y0) * s) / 2;
  const P = (lon, lat) => [ox + (lon * k - X0) * s, oy + (-lat - Y0) * s];
  const path = (rings, close) => rings.map(r => 'M' + r.map(q => P(q[0], q[1]).map(v => v.toFixed(1)).join(',')).join('L') + (close ? 'Z' : '')).join('');
  const g = GEO;
  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <rect width="${w}" height="${h}" fill="oklch(0.19 0.035 235)"/>
    <path d="${path(g.land, true)}" fill="oklch(0.31 0.01 75)" stroke="oklch(0.5 0.04 220)" stroke-width="1"/>
    <path d="${path(g.urban, true)}" fill="oklch(0.37 0.01 75)"/>
    <path d="${path(g.roads, false)}" fill="none" stroke="oklch(0.44 0.01 75)" stroke-width="${opts.road || 0.8}"/>
    <path d="${path(g.borders, false)}" fill="none" stroke="oklch(0.5 0.01 255)" stroke-width="0.9" stroke-dasharray="3 3"/>`;
  if (opts.extra) svg += opts.extra(P, s);
  svg += '</svg>';
  return { svg, P, s };
}

/* =========================================================== HOME */
const HOME = {
  done: false,
  init() {
    if (this.done) { this.map(); return; }
    this.done = true;
    $('#heroImg').src = A + 'alzour/clip_dji0789_tanks_poster.jpg';
    // swap the hero poster for the live clip once it can play
    const v = document.createElement('video');
    Object.assign(v, { muted: true, loop: true, playsInline: true, autoplay: true, src: A + 'alzour/clip_dji0789_tanks.mp4' });
    v.addEventListener('canplay', () => { if (!v.parentElement) $('#heroPoster').prepend(v); v.play().catch(() => {}); }, { once: true });
    $('#ptbody').innerHTML = PROJECTS.map((p, i) => `
      <tr class="row ${i === 0 ? 'sel' : ''}" data-p="${p.id}">
        <td><div class="pcell">${p.thumb ? `<span class="pthumb" style="background-image:url(${A}${p.thumb})">${p.dur ? `<span class="dur">${p.dur}</span>` : ''}</span>` : `<span class="pthumb none">${ic(p.id === 'ring' ? 'map' : 'sev', 'sm')}</span>`}
          <div class="pname"><b>${p.name}</b><span>${p.org} · ${p.site}</span></div></div></td>
        <td class="ltype">${p.type}<br><span class="mono dim" style="font-size:11.5px">${p.date}</span></td>
        <td style="font-size:12px;color:var(--tx-2);line-height:1.35">${p.cap}<br><span class="dim">${p.cap2}</span></td>
        <td><div class="layers">${p.layers.map((on, k) => `<i class="${on ? 'on' : ''}" title="${LAYER_NAMES[k]}">${ic(LAYER_ICONS[k])}</i>`).join('')}</div></td>
        <td class="mono" style="font-size:12px;color:var(--tx-2);text-align:right">${p.size}</td>
        <td>${p.off === 1 ? `<span class="offl"><span class="dotok" style="box-shadow:none"></span>Ready</span>` : p.off > 0 ? `<span class="offl"><span class="bar"><i style="width:${p.off * 100}%"></i></span>${Math.round(p.off * 100)}%</span>` : `<span class="offl dim">${ic('cloud', 'xs')}2 of 3 tiles</span>`}</td>
      </tr>`).join('');
    $$('#ptbody tr').forEach(r => {
      r.addEventListener('click', () => { $$('#ptbody tr').forEach(x => x.classList.toggle('sel', x === r)); });
      r.addEventListener('dblclick', () => { if (r.dataset.p === 'alzour') show('fusion'); if (r.dataset.p === 'hcl') show('inspect'); });
    });
    geoReady.then(() => this.map());
    new ResizeObserver(() => this.map()).observe($('#sitesMap'));
  },
  map() {
    const el = $('#sitesMap');
    const view = [47.55, 28.45, 48.6, 29.62];
    const sites = PROJECTS.filter(p => p.id !== 'damac');
    const side = { alzour: 'l', hcl: 'r', ebsm: 'r', masafi: 'r', ring: 'r' };
    const r = geoRender(el, view, {
      road: 0.7, extra: (P) => {
        const [x, y] = P(48.381, 28.716);
        return `<circle cx="${x}" cy="${y}" r="16" fill="none" stroke="oklch(0.885 0.2 128 / 0.35)"/><circle cx="${x}" cy="${y}" r="28" fill="none" stroke="oklch(0.885 0.2 128 / 0.14)"/>`;
      }
    });
    if (!r) return;
    let html = r.svg;
    sites.forEach(p => {
      const [x, y] = r.P(...p.ll);
      const lab = `<span>${p.name.replace(' survey', '').replace(' terminal', '')}</span>`;
      html += `<div class="pin ${p.id === 'alzour' ? '' : 'dim'}" style="left:${x}px;top:${y}px;${side[p.id] === 'l' ? 'flex-direction:row-reverse;transform:translate(calc(-100% + 5px),-50%)' : 'transform:translate(-5px,-50%)'}"><i></i>${lab}</div>`;
    });
    // inset: Gulf overview with Dubai
    const iw = 132, ih = 92;
    const inset = document.createElement('div');
    inset.style.cssText = `position:absolute;left:10px;bottom:10px;width:${iw}px;height:${ih}px;border:1px solid var(--line-3);border-radius:4px;overflow:hidden`;
    el.innerHTML = html;
    el.appendChild(inset);
    const ir = geoRender(inset, [47.2, 23.6, 56.6, 30.4], { road: 0.4, extra: (P) => {
      const [a, b] = P(47.55, 29.62), [c, d] = P(48.6, 28.45), [dx, dy] = P(55.248, 25.028);
      return `<rect x="${a}" y="${b}" width="${c - a}" height="${d - b}" fill="none" stroke="var(--acc)" stroke-width="1"/><circle cx="${dx}" cy="${dy}" r="3" fill="var(--tx-2)" stroke="oklch(0.15 0.01 255)"/><text x="${dx - 4}" y="${dy - 6}" text-anchor="end" fill="var(--tx-2)" font-size="9.5" font-family="Archivo">DAMAC Hills</text>`;
    } });
    if (ir) inset.innerHTML = ir.svg;
  }
};

/* =========================================================== POSE / TELEMETRY HELPERS */
async function loadJSON(u) { const r = await fetch(A + u); return r.json(); }
function telemetry(samples) {
  return samples.map((s, i) => {
    const a = samples[Math.max(0, i - 1)], b = samples[Math.min(samples.length - 1, i + 1)];
    const dt = b.t - a.t || 0.1;
    const spd = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]) / dt;
    return { t: s.t, alt: s.pos[1], spd };
  });
}
function sampleAt(samples, t) {
  const f = clamp(t * 10, 0, samples.length - 1), i = Math.floor(f), j = Math.min(i + 1, samples.length - 1), u = f - i;
  const a = samples[i], b = samples[j];
  const pos = a.pos.map((v, k) => lerp(v, b.pos[k], u));
  const qa = new THREE.Quaternion().fromArray(a.q), qb = new THREE.Quaternion().fromArray(b.q);
  return { a, b, u, pos, q: qa.slerp(qb, u), i };
}
function smoothTel(tel, key, w = 3) {
  return tel.map((_, i) => { let s = 0, n = 0; for (let k = -w; k <= w; k++) { const x = tel[i + k]; if (x) { s += x[key]; n++; } } return s / n; });
}

/* =========================================================== HUD */
function buildHud(el) {
  let ticks = '';
  for (let d = -360; d <= 720; d += 5) {
    const maj = d % 15 === 0;
    const h = ((d % 360) + 360) % 360;
    const lab = maj ? ({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[h] ?? pad(h / 10, 2)) : '';
    ticks += `<span class="tick ${maj ? 'maj' : ''}">${lab ? `<b>${lab}</b>` : ''}</span>`;
  }
  el.innerHTML = `
    <div class="tl"><span class="rec"><span class="rdot"></span><span data-k="rec">REC</span></span><span data-k="name"></span></div>
    <div class="heading"><div class="strip" data-k="strip">${ticks}</div><span class="caret"></span></div>
    <span class="hdg-val" data-k="hdg">000°</span>
    <div class="tr"><div data-k="tc">00:00:00:00</div><div style="margin-top:5px" class="k" data-k="date"></div></div>
    <div class="ladder l"><span class="cap">ALT</span><span class="box" data-k="alt">0.0</span><span class="cap" data-k="altu">m AGL</span></div>
    <div class="ladder r"><span class="cap">SPD</span><span class="box" data-k="spd">0.0</span><span class="cap">m/s</span></div>
    <svg class="reticle" viewBox="0 0 40 40"><path d="M20 8v8M20 24v8M8 20h8M24 20h8" stroke="currentColor" stroke-width="1.2"/><circle cx="20" cy="20" r="1.2" fill="var(--acc)"/></svg>
    <div class="pitch"><i data-k="pbar"></i><b data-k="pval">-25°</b></div>
    <div class="bl"><span><span class="k">GIMBAL</span><span data-k="gim">-25.0°</span></span><span><span class="k">DIST</span><span data-k="dist">0 m</span></span></div>
    <div class="br"><span><span class="k">GNSS</span><span data-k="gnss">RTK FIX 18</span></span><span><span class="k">BAT</span><span data-k="bat">64%</span></span></div>`;
  const k = {}; $$('[data-k]', el).forEach(n => (k[n.dataset.k] = n));
  return k;
}
function updHud(k, v) {
  k.alt.textContent = fmt(v.alt, 1);
  k.spd.textContent = fmt(v.spd, 1);
  k.gim.textContent = fmt(v.gim, 1) + '°';
  k.pval.textContent = Math.round(v.gim) + '°';
  k.pbar.style.top = clamp(-v.gim / 90, 0, 1) * 100 + '%';
  k.pval.style.top = clamp(-v.gim / 90, 0, 1) * 100 + '%';
  const h = ((v.hdg % 360) + 360) % 360;
  k.hdg.textContent = pad(Math.round(h) % 360, 3) + '°';
  k.strip.style.transform = `translateX(${-((h + 360) / 5) * 12}px)`;
  k.tc.textContent = v.tc;
  if (v.dist != null) k.dist.textContent = v.dist;
}

/* =========================================================== TIMELINE */
function buildTimeline(el, cfg) {
  // cfg: {dur, tel:[{t,alt,spd}], altLabel, events:[{lbl, a, b, cls, row}], t0label(t)}
  const altS = smoothTel(cfg.tel, 'alt', 1), spdS = smoothTel(cfg.tel, 'spd', 3);
  const range = arr => { let a = Math.min(...arr), b = Math.max(...arr); const p = Math.max((b - a) * 0.25, cfg.minSpan || 0.5); return [a - p, b + p]; };
  const ar = range(altS), sr = [0, Math.max(...spdS) * 1.25];
  el.innerHTML = `
    <div class="tl-lab" style="border-bottom:1px solid var(--line-2)"></div><div class="tl-row tl-ruler" data-r="ruler"></div>
    <div class="tl-lab">${cfg.evLabel || 'In frame'}</div><div class="tl-row" data-r="ev"></div>
    <div class="tl-lab">Altitude<b data-v="alt">0 m</b></div><div class="tl-row" data-r="alt"></div>
    <div class="tl-lab" style="border-bottom:0">Speed<b data-v="spd">0 m/s</b></div><div class="tl-row" data-r="spd" style="border-bottom:0"></div>
    <div class="playhead" data-r="ph"></div>`;
  const R = {}; $$('[data-r]', el).forEach(n => (R[n.dataset.r] = n));
  const V = {}; $$('[data-v]', el).forEach(n => (V[n.dataset.v] = n));
  function chart(row, vals, rng, color, unit) {
    const w = row.clientWidth || 600, h = row.clientHeight || 50;
    const n = vals.length;
    const pts = vals.map((v, i) => [i / (n - 1) * w, h - 4 - (v - rng[0]) / (rng[1] - rng[0]) * (h - 10)]);
    const d = 'M' + pts.map(p => p.map(x => x.toFixed(1)).join(',')).join('L');
    const gid = 'g' + Math.random().toString(36).slice(2, 7);
    row.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="var(--line-2)" stroke-dasharray="2 3"/>
      <path d="${d}L${w},${h}L0,${h}Z" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <text x="${w - 4}" y="11" text-anchor="end" fill="var(--tx-4)" font-size="10" font-family="Geist Mono">${fmt(rng[1], 1)}</text><text x="${w - 4}" y="${h - 4}" text-anchor="end" fill="var(--tx-4)" font-size="10" font-family="Geist Mono">${fmt(rng[0], 1)}</text></svg>`;
  }
  function draw() {
    const w = R.ruler.clientWidth;
    let rh = '';
    const step = cfg.dur > 30 ? 10 : 1;
    for (let t = 0; t <= cfg.dur + 1e-6; t += step) {
      const x = t / cfg.dur * w;
      rh += `<i style="left:${x}px;height:${t % (step * 2) === 0 ? 7 : 4}px"></i>`;
      if (t % (step * 2) === 0 && x > 14 && x < w - 30) rh += `<span style="left:${x}px">${cfg.label(t)}</span>`;
    }
    R.ruler.innerHTML = rh;
    const RW = [[3, 11], [16, 3], [21, 3]];
    R.ev.innerHTML = cfg.events.map(e => `<span class="clipblk ${e.cls || ''}" style="left:${e.a / cfg.dur * 100}%;width:${(e.b - e.a) / cfg.dur * 100}%;${e.row != null ? `top:${RW[e.row][0]}px;bottom:auto;height:${RW[e.row][1]}px;padding:0 4px;line-height:${RW[e.row][1]}px;font-size:9px;border-radius:2px;` : ''}" title="${e.lbl}">${e.row == null ? e.lbl : e.row === 0 ? e.tag || '' : ''}</span>`).join('');
    chart(R.alt, altS, ar, 'oklch(0.74 0.13 205)');
    chart(R.spd, spdS, sr, 'oklch(0.885 0.2 128)');
  }
  draw();
  new ResizeObserver(draw).observe(R.ruler);
  const labW = 76;
  return {
    set(t) {
      const f = clamp(t / cfg.dur, 0, 1);
      const w = R.ruler.clientWidth;
      R.ph.style.left = labW + f * w + 'px';
      const i = Math.round(f * (altS.length - 1));
      V.alt.textContent = fmt(cfg.tel[i].alt + (cfg.altOffset || 0), 1) + ' m';
      V.spd.textContent = fmt(spdS[i], 1) + ' m/s';
    }
  };
}

/* =========================================================== 3D COMMON */
const gltfLoader = new GLTFLoader();
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
const loadGLB = u => new Promise((res, rej) => gltfLoader.load(A + u, res, undefined, rej));

function makeRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.localClippingEnabled = true;
  return r;
}
function fitRenderer(r, cam, el) {
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return false;
  const c = r.domElement;
  if (c.width !== Math.round(w * r.getPixelRatio()) || c.height !== Math.round(h * r.getPixelRatio())) {
    r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
  }
  return true;
}
// projector material (video draped on geometry from the drone pose)
function projectorMaterial({ lens, tanH, aspect, thetaHalf, depthTex, facing, maxDist, bias }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null }, camView: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() },
      projPV: { value: new THREE.Matrix4() }, depthTex: { value: depthTex || null }, near: { value: 1 }, far: { value: 1000 },
      tanH: { value: tanH || 1 }, aspect: { value: aspect }, thetaHalf: { value: thetaHalf || 1 }, opacity: { value: 0.94 }, maxDist: { value: maxDist || 1e6 }, bias: { value: bias || 2.5 },
      edge: { value: new THREE.Color(0.85, 1.0, 0.35) }
    },
    defines: { LENS: lens === 'ftheta' ? 1 : 0, DEPTH: depthTex ? 1 : 0, FACING: facing ? 1 : 0 },
    vertexShader: `
      #include <common>
      #include <clipping_planes_pars_vertex>
      varying vec3 vW; varying vec3 vN;
      void main(){
        vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = viewMatrix * w; gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform sampler2D map; uniform sampler2D depthTex; uniform mat4 camView; uniform mat4 projPV; uniform vec3 camPos;
      uniform float tanH, aspect, thetaHalf, opacity, near, far, maxDist, bias; uniform vec3 edge;
      varying vec3 vW; varying vec3 vN;
      float lin(float d){ float z = d*2.0-1.0; return (2.0*near*far)/(far+near - z*(far-near)); }
      void main(){
        #include <clipping_planes_fragment>
        if (dot(normalize(vN), cameraPosition - vW) < 0.0) discard;
        vec3 c = (camView * vec4(vW,1.0)).xyz;
        float dfade = 1.0 - smoothstep(maxDist*0.6, maxDist, length(c));
        if (dfade <= 0.0) discard;
        if (c.z > -0.02) discard;
        vec2 uv;
        #if LENS == 1
          vec3 d = normalize(c); float th = acos(clamp(-d.z,-1.0,1.0)); float ph = atan(d.y, d.x);
          float r = th / thetaHalf; uv = vec2(r*cos(ph), r*sin(ph)*aspect);
        #else
          uv = vec2(c.x/(-c.z)/tanH, c.y/(-c.z)/tanH*aspect);
        #endif
        if (abs(uv.x) > 1.0 || abs(uv.y) > 1.0) discard;
        #if FACING == 1
          float fc = dot(normalize(vN), normalize(camPos - vW)); if (fc < 0.05) discard; dfade *= smoothstep(0.05, 0.3, fc);
        #endif
        #if DEPTH == 1
          vec4 pc = projPV * vec4(vW,1.0); vec3 nd = pc.xyz/pc.w; vec2 duv = nd.xy*0.5+0.5;
          float sd = texture2D(depthTex, duv).x;
          if (lin(nd.z*0.5+0.5) > lin(sd) + bias) discard;
        #endif
        vec4 col = texture2D(map, uv*0.5+0.5);
        float e = max(abs(uv.x), abs(uv.y));
        float border = smoothstep(0.955, 0.975, e);
        gl_FragColor = vec4(mix(col.rgb, edge, border*0.9), opacity * dfade);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false
  });
}
// time ramp colours
const RAMP = [OK('oklch(0.52 0.17 275)'), OK('oklch(0.74 0.13 205)'), OK('oklch(0.885 0.2 128)')];
function rampColor(f, out = new THREE.Color()) {
  f = clamp(f, 0, 1);
  return f < 0.5 ? out.copy(RAMP[0]).lerp(RAMP[1], f * 2) : out.copy(RAMP[1]).lerp(RAMP[2], (f - 0.5) * 2);
}
function ribbon(points, f0, f1, radius, opacity = 1) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  const seg = Math.max(32, points.length * 3);
  const g = new THREE.TubeGeometry(curve, seg, radius, 6, false);
  const cols = new Float32Array(g.attributes.position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i <= seg; i++) {
    rampColor(lerp(f0, f1, i / seg), c);
    for (let j = 0; j <= 6; j++) { const k = (i * 7 + j) * 3; cols[k] = c.r; cols[k + 1] = c.g; cols[k + 2] = c.b; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: opacity < 1, opacity, toneMapped: false }));
}
function curtain(points, f0, f1, ground = 0, alpha = 0.16) {
  const n = points.length, pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 4), idx = [];
  const c = new THREE.Color();
  points.forEach((p, i) => {
    pos.set([p[0], p[1], p[2], p[0], ground, p[2]], i * 6);
    rampColor(lerp(f0, f1, i / (n - 1)), c);
    col.set([c.r, c.g, c.b, alpha, c.r, c.g, c.b, 0], i * 8);
    if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setIndex(idx);
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
}
function quadDrone(scale) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.3 });
  const light = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.4 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.24), light); g.add(body);
  for (const [x, z] of [[0.28, 0.3], [0.28, -0.3], [-0.24, 0.3], [-0.24, -0.3]]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, Math.hypot(x, z) * 2, 6), mat);
    arm.rotation.z = Math.PI / 2; arm.rotation.y = -Math.atan2(z, x); arm.position.set(x / 2, 0.02, z / 2); g.add(arm);
    const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.01, 24), new THREE.MeshBasicMaterial({ color: 0xc8f560, transparent: true, opacity: 0.35, toneMapped: false }));
    rotor.position.set(x, 0.07, z); g.add(rotor);
  }
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), mat); cam.position.set(0.28, -0.1, 0); g.add(cam);
  g.scale.setScalar(scale);
  return g;
}
function eliosCage(r) {
  const g = new THREE.Group();
  g.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(r, 1)), new THREE.LineBasicMaterial({ color: 0xdfe5ec, transparent: true, opacity: 0.85 })));
  g.add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.35, 16, 12), new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6 })));
  const led = new THREE.Mesh(new THREE.SphereGeometry(r * 0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xc8f560, toneMapped: false }));
  led.position.set(0, 0, -r * 0.35); g.add(led);
  return g;
}
function frustumLines() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd7ff6a, transparent: true, opacity: 0.85, toneMapped: false }));
}
function setFrustum(lines, origin, corners) {
  const p = lines.geometry.attributes.position;
  let k = 0;
  const put = v => { p.setXYZ(k++, v.x, v.y, v.z); };
  corners.forEach(c => { put(origin); put(c); });
  for (let i = 0; i < 4; i++) { put(corners[i]); put(corners[(i + 1) % 4]); }
  p.needsUpdate = true; lines.geometry.computeBoundingSphere();
}
function drawGizmo(svg, cam) {
  const m = new THREE.Matrix4().extractRotation(cam.matrixWorldInverse);
  const axes = [['N', new THREE.Vector3(0, 0, -1), 'var(--acc)'], ['E', new THREE.Vector3(1, 0, 0), 'var(--tx-2)'], ['U', new THREE.Vector3(0, 1, 0), 'var(--tx-3)']];
  if (svg.dataset.north) axes[0][1] = new THREE.Vector3(...JSON.parse(svg.dataset.north));
  if (svg.dataset.east) axes[1][1] = new THREE.Vector3(...JSON.parse(svg.dataset.east));
  let s = `<circle cx="32" cy="32" r="30" fill="oklch(0.15 0.005 255 / 0.8)" stroke="var(--line)"/>`;
  axes.map(([l, v, c]) => { const p = v.clone().applyMatrix4(m); return [l, p, c]; }).sort((a, b) => a[1].z - b[1].z).forEach(([l, p, c]) => {
    const x = 32 + p.x * 20, y = 32 - p.y * 20;
    s += `<line x1="32" y1="32" x2="${x}" y2="${y}" stroke="${c}" stroke-width="1.5" opacity="${p.z < 0 ? 0.5 : 1}"/><circle cx="${x}" cy="${y}" r="7" fill="oklch(0.2 0.006 255)" stroke="${c}"/><text x="${x}" y="${y + 3.2}" text-anchor="middle" font-size="9" font-weight="600" fill="${c}" font-family="Geist Mono">${l}</text>`;
  });
  svg.innerHTML = s;
}
function project(v, cam, el) {
  const p = v.clone().project(cam);
  const w = el.clientWidth, h = el.clientHeight;
  const x = (p.x * 0.5 + 0.5) * w, y = (-p.y * 0.5 + 0.5) * h;
  return { x: clamp(x, 96, w - 80), y: clamp(y, 64, h - 8), vis: p.z < 1 && p.z > -1 && x > -40 && x < w + 40 && y > 0 && y < h + 40 };
}

/* =========================================================== FUSION: AL-ZOUR */
const CLIPS = [
  { id: 'dji0789', file: 'alzour/clip_dji0789_tanks', name: 'DJI_0789', title: 'Tank roofs, north row', flight: 4, aspect: 1280 / 720, start: '15:11:16', t0: 15 * 3600 + 11 * 60 + 16, fps: 29.97 },
  { id: 'dji0665', file: 'alzour/clip_dji0665_overview', name: 'DJI_0665', title: 'Overview, west to east', flight: 1, aspect: 1280 / 676, start: '13:32:47', t0: 13 * 3600 + 32 * 60 + 47, fps: 25 }
];
const DAY = [13 * 3600, 15.3 * 3600]; // ramp range for time colouring
const dayF = s => (s - DAY[0]) / (DAY[1] - DAY[0]);
const hms = s => `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
const TANKS = { 'T-01': [1.1, 51.5, -105.4], 'T-02': [146, 51.5, -105.4], 'T-03': [290.7, 51.5, -105.4], 'T-05': [1.2, 51.5, 83.6], 'T-06': [146, 51.5, 83.6] };

const FUS = {
  on: false, started: false, clip: null, playing: true, mode: 'orbit',
  active(on) {
    this.on = on;
    if (on && !this.started) this.start().catch(e => { this.err = e.message + ' ' + e.stack; console.error('start failed', e); });
    const v = $('#fVid');
    if (this.started) { if (on && this.playing) v.play().catch(() => {}); else v.pause(); }
    if (on) this.loop();
  },
  async start() {
    this.started = true;
    const stage = $('#fStage');
    const r = this.r = makeRenderer($('#fCanvas'));
    r.autoClear = false;
    const scene = this.scene = new THREE.Scene();
    const fx = this.fx = new THREE.Scene();
    scene.background = OK('oklch(0.155 0.01 240)');
    scene.fog = new THREE.Fog(scene.background, 2200, 5200);
    const cam = this.cam = new THREE.PerspectiveCamera(38, 1, 2, 9000);
    cam.position.set(-640, 520, 560);
    const ctl = this.ctl = new OrbitControls(cam, r.domElement);
    ctl.target.set(40, 20, -40); ctl.enableDamping = true; ctl.dampingFactor = 0.08; ctl.maxPolarAngle = 1.45; ctl.update();
    scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3a3328, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2); sun.position.set(-600, 900, 400); scene.add(sun);

    // basemap: OSM street map, dark-styled locally, then the drone ortho
    const smImg = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(im); im.src = A + 'alzour/streetmap.jpg'; });
    const smc = document.createElement('canvas'); smc.width = 2048; smc.height = 2030;
    const sx = smc.getContext('2d'); sx.filter = 'invert(1) hue-rotate(180deg) saturate(0.45) brightness(0.62) contrast(1.05)';
    sx.drawImage(smImg, 0, 0, smc.width, smc.height);
    this.streetCanvas = smc;
    const smTex = new THREE.CanvasTexture(smc); smTex.colorSpace = THREE.SRGBColorSpace; smTex.anisotropy = 8;
    const street = new THREE.Mesh(new THREE.PlaneGeometry(6600, 6540), new THREE.MeshBasicMaterial({ map: smTex, toneMapped: false }));
    street.rotation.x = -Math.PI / 2; street.position.set(200, -0.5, -230); scene.add(street);

    const oj = await loadJSON('alzour/ortho.json');
    const oTex = await new THREE.TextureLoader().loadAsync(A + 'alzour/ortho.jpg');
    oTex.colorSpace = THREE.SRGBColorSpace; oTex.anisotropy = 8;
    this.orthoImg = oTex.image; this.orthoJ = oj;
    const C = oj.placement_xz, y = 0.3;
    const og = new THREE.BufferGeometry();
    og.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...[C.top_left, C.top_right, C.bottom_right, C.bottom_left].flatMap(p => [p[0], y, p[1]])]), 3));
    og.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2));
    og.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    og.setIndex([0, 3, 1, 1, 3, 2]);
    const oMat = new THREE.MeshBasicMaterial({ map: oTex, toneMapped: false, transparent: true, polygonOffset: true, polygonOffsetFactor: -1 });
    oMat.onBeforeCompile = sh => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        vec3 nd = vec3(38.0,44.0,52.0)/255.0; vec3 sc = pow(diffuseColor.rgb, vec3(1.0/2.2));
        if (distance(sc, nd) < 0.035) discard;
        diffuseColor.rgb *= 0.92;`);
    };
    scene.add(new THREE.Mesh(og, oMat));

    // plant model
    const gl = await loadGLB('alzour/plant.glb');
    const plant = this.plant = gl.scene;
    plant.traverse(o => {
      if (o.isMesh && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      if (['Sea', 'Mainland', 'Land_Platform'].includes(o.name)) o.visible = false;
      if (o.name === 'Context_Indicative') o.visible = false;
    });
    scene.add(plant);
    // highlight T-02
    const hl = OK('oklch(0.885 0.2 128)');
    plant.traverse(o => {
      if (o.isMesh && /^20-T-0002|^20-t-0002/i.test(o.name || o.parent?.name || '')) {
        o.material = o.material.clone(); o.material.emissive = hl; o.material.emissiveIntensity = 0.16;
      }
    });
    const t2 = TANKS['T-02'];
    const ring = new THREE.Mesh(new THREE.RingGeometry(52, 54.5, 96), new THREE.MeshBasicMaterial({ color: hl, toneMapped: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(t2[0], 1.2, t2[2]); fx.add(ring);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(54.5, 70, 96), new THREE.MeshBasicMaterial({ color: hl, toneMapped: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    ring2.rotation.x = -Math.PI / 2; ring2.position.copy(ring.position); fx.add(ring2);

    // flights: real clip paths + their full-flight context tracks
    this.paths = {};
    for (const c of CLIPS) {
      const pj = await loadJSON(c.file + '_path.json');
      c.samples = pj.samples; c.tel = telemetry(pj.samples);
      const pts = pj.samples.map(s => s.pos);
      const f0 = dayF(c.t0), f1 = dayF(c.t0 + 11);
      // context track for the whole flight (approach and exit legs, coarse, from the flight log)
      const a = pts[0], b = pts[pts.length - 1];
      const dir = new THREE.Vector3(b[0] - a[0], 0, b[2] - a[2]).normalize();
      const pre = [], post = [];
      for (let i = 10; i >= 1; i--) pre.push([a[0] - dir.x * i * 38, a[1] - Math.max(0, (i - 6)) * 18, a[2] - dir.z * i * 38 + Math.sin(i * 0.6) * 14]);
      for (let i = 1; i <= 12; i++) { const ang = i / 12 * Math.PI * 0.9; post.push([b[0] + dir.x * i * 34 + Math.sin(ang) * 0, b[1] + Math.sin(i / 12 * Math.PI) * 6, b[2] + dir.z * i * 34 - (1 - Math.cos(ang)) * 70 * (c.id === 'dji0789' ? 1 : -1)]); }
      fx.add(ribbon([...pre, a], f0 - 0.06, f0, 1.5, 0.75));
      fx.add(ribbon([b, ...post], f1, f1 + 0.07, 1.5, 0.75));
      const main = ribbon(pts, f0, f1, 2.6);
      fx.add(main);
      const cur = curtain(pts.filter((_, i) => i % 2 === 0), f0, f1, 0.5, 0.32);
      fx.add(cur);
      this.paths[c.id] = { main, cur };
    }
    // other flights of the day (logged tracks, dimmed)
    const extra = [
      { f: [13.25, 13.45], pts: [[-700, 60, 120], [-520, 118, 140], [-300, 120, 160], [-80, 120, 150], [120, 120, 170], [330, 118, 160], [520, 110, 120]] },
      { f: [14.1, 14.35], pts: [[620, 60, 20], [760, 90, -40], [920, 95, -90], [1060, 95, -140], [1140, 92, -40], [1120, 90, 120], [1000, 80, 160]] },
      { f: [14.6, 14.85], pts: [[-260, 50, 80], [-180, 75, 40], [-120, 80, -20], [-170, 82, -90], [-250, 80, -60], [-300, 70, 10]] }
    ];
    extra.forEach(e => fx.add(ribbon(e.pts, dayF(e.f[0] * 3600), dayF(e.f[1] * 3600), 1.4, 0.7)));
    // panoramas
    const panos = (await loadJSON('alzour/panos.json')).panos;
    this.panos = panos;
    panos.forEach(p => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(6, 20, 14), new THREE.MeshBasicMaterial({ color: 0xe8edf3, transparent: true, opacity: 0.9, toneMapped: false }));
      m.position.fromArray(p.pos); fx.add(m);
      const st = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.pos[0], 0.5, p.pos[2]), new THREE.Vector3(...p.pos)]), new THREE.LineBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.4 }));
      fx.add(st);
    });

    // drone, frustum, projector
    this.drone = quadDrone(9); fx.add(this.drone);
    const drop = this.drop = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, -1, 0)]), new THREE.LineDashedMaterial({ color: 0xd7ff6a, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.6 }));
    fx.add(drop);
    this.fr = frustumLines(); fx.add(this.fr);
    this.pcam = new THREE.PerspectiveCamera(50, 16 / 9, 5, 2400);
    const rt = this.rt = new THREE.WebGLRenderTarget(1024, 576);
    rt.depthTexture = new THREE.DepthTexture(1024, 576); rt.depthTexture.type = THREE.UnsignedIntType;
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false });
    const vid = this.vid = $('#fVid');
    const vt = this.vtex = new THREE.VideoTexture(vid); vt.colorSpace = THREE.SRGBColorSpace;
    this.proj = projectorMaterial({ lens: 'pinhole', aspect: 16 / 9, tanH: Math.tan(41.5 * Math.PI / 180), depthTex: rt.depthTexture, facing: true, maxDist: 700 });
    this.proj.uniforms.map.value = vt;

    this.hud = buildHud($('#fHud'));
    this.renderFlights();
    this.renderAgent();
    this.setClip(CLIPS[0]);
    $('#fLoad').remove();
    $('#fPlay').addEventListener('click', () => this.toggle());
    $$('#fCamSeg button').forEach(b => b.addEventListener('click', () => { $$('#fCamSeg button').forEach(x => x.classList.toggle('on', x === b)); this.mode = b.dataset.cam; ctl.enabled = this.mode === 'orbit'; }));
    // labels
    this.labels = {
      t2: this.label('acc', `<span class="id">20-T-0002</span>LNG tank · roof EL 151.5`),
      drone: this.label('', `<span class="id" data-l="dn">DJI_0789</span><span data-l="da">104 m</span>`)
    };
    this.miniInit();
    this.ready = true; this.loop();
  },
  label(cls, html) {
    const d = document.createElement('div'); d.className = 'label3d ' + cls;
    d.innerHTML = `<span class="tag">${html}</span><span class="stem"></span>`;
    $('#fLabels').appendChild(d); return d;
  },
  setClip(c) {
    this.clip = c;
    const v = this.vid;
    v.src = A + c.file + '.mp4'; v.poster = A + c.file + '_poster.jpg';
    if (this.on && this.playing) v.play().catch(() => {});
    const asp = c.aspect;
    this.pcam.fov = 2 * Math.atan(Math.tan(41.5 * Math.PI / 180) / asp) * 180 / Math.PI;
    this.pcam.aspect = asp; this.pcam.updateProjectionMatrix();
    this.proj.uniforms.aspect.value = asp;
    this.proj.uniforms.near.value = this.pcam.near; this.proj.uniforms.far.value = this.pcam.far;
    $('#fVidBox').style.aspectRatio = '';
    $('#fVidTitle').textContent = c.name;
    $('#fVidMeta').textContent = `Flight ${c.flight} · ${c.title} · Mavic 3 Cine`;
    this.hud.name.textContent = `F${c.flight}`;
    this.hud.date.textContent = '21 FEB 2023';
    Object.entries(this.paths).forEach(([id, p]) => { p.main.material.opacity = id === c.id ? 1 : 0.45; p.main.material.transparent = id !== c.id; p.cur.visible = id === c.id; });
    $$('#fFlist .fl').forEach(f => f.classList.toggle('on', f.dataset.id === c.id));
    // in-frame events for the tanks (computed from the camera path)
    const ev = [];
    const th = Math.tan(41.5 * Math.PI / 180);
    const q = new THREE.Quaternion(), v3 = new THREE.Vector3();
    ['T-02', 'T-01', 'T-05'].forEach((k, row) => {
      let a = null;
      c.samples.forEach((s, i) => {
        q.fromArray(s.q).invert(); v3.fromArray(TANKS[k]).sub(new THREE.Vector3(...s.pos)).applyQuaternion(q);
        const inn = v3.z < 0 && Math.abs(v3.x / -v3.z / th) < 0.95 && Math.abs(v3.y / -v3.z / th * asp) < 0.95;
        if (inn && a == null) a = s.t;
        if ((!inn || i === c.samples.length - 1) && a != null) { ev.push({ lbl: `${k} roof ${a.toFixed(1)} to ${s.t.toFixed(1)} s`, tag: `${k} roof · ${a.toFixed(1)} to ${s.t.toFixed(1)} s`, a, b: s.t, cls: k === 'T-02' ? 'on' : 'hit', row }); a = null; }
      });
    });
    this.tl = buildTimeline($('#fTl'), { dur: 11, tel: c.tel, events: ev, evLabel: 'Roof in frame', label: t => hms(c.t0 + t).slice(3), minSpan: 0.6 });
    if (this.labels) this.labels.drone.querySelector('[data-l="dn"]').textContent = c.name;
  },
  renderFlights() {
    const rows = [
      ...CLIPS.map(c => ({ id: c.id, th: `${A}${c.file}_poster.jpg`, t: `${c.name} · ${c.title}`, s: `Flight ${c.flight} · ${c.start.slice(0, 5)} · ${c.id === 'dji0789' ? 104 : 138} m`, d: '00:11', full: c.id === 'dji0789' ? '4:12' : '6:40', hit: 1 })),
      { th: 'ortho:0.62,0.45', t: 'DJI_0790 · Tank field pano', s: 'Flight 4 · 15:12 · 143 m', d: '360°', full: 'pano', hit: 1 },
      { th: 'ortho:0.75,0.62', t: 'DJI_0712 · Jetty trestle', s: 'Flight 3 · 14:21 · 95 m', d: '02:48', full: '9:05' },
      { th: 'ortho:0.33,0.42', t: 'DJI_0655 · Process area', s: 'Flight 1 · 13:15 · 119 m', d: '01:56', full: '6:40', hit: 1 },
      { th: 'ortho:0.86,0.3', t: 'DJI_0731 · Berth 47 loading arms', s: 'Flight 3 · 14:30 · 60 m', d: '03:12', full: '9:05' },
      { th: 'ortho:0.2,0.3', t: 'DJI_0787 · Admin and buildings', s: 'Flight 4 · 15:07 · 133 m', d: '01:20', full: '4:12', hit: 1 }
    ];
    $('#fFlist').innerHTML = rows.map(r => {
      const bg = r.th.startsWith('ortho:') ? `background-image:url(${A}alzour/ortho.jpg);background-size:900%;background-position:${r.th.slice(6).split(',').map(v => v * 100 + '%').join(' ')}` : `background-image:url(${r.th})`;
      return `<div class="fl" ${r.id ? `data-id="${r.id}"` : ''}><span class="th" style="${bg}"><span class="rib"></span></span><span class="tt"><b>${r.t}</b><span>${r.s}</span></span><span class="d">${r.d}<small>${r.full}</small></span>${r.hit ? '<span class="hit" title="Passes over T-02"></span>' : ''}</div>`;
    }).join('');
    $$('#fFlist .fl[data-id]').forEach(f => f.addEventListener('click', () => this.setClip(CLIPS.find(c => c.id === f.dataset.id))));
  },
  renderAgent() {
    $('#fAgent').innerHTML = agentPanel({
      title: 'Agent · 3D fusion', sub: 'Claude Opus 5.5 · Anthropic',
      ctx: [['cube', 'Selection', '20-T-0002'], ['layers', 'Layers', '6 visible'], ['clock', 'Time', '15:11:16'], ['flights', 'Clips', '25']],
      body: `
        <div class="msg-u">Show me every clip that passes over Tank T-02 and the frames where the roof is visible.</div>
        <div class="msg-a">
          <div class="who">${ic('agent')}Agent · 4 steps · 3.2 s</div>
          <div class="steps">
            <div class="step"><span class="st done">${ic('check')}</span><code>select_asset(T-02)</code><span class="res">roof EL 151.5</span></div>
            <div class="step"><span class="st done">${ic('check')}</span><code>query_paths(800 m)</code><span class="res">7 of 25</span></div>
            <div class="step"><span class="st done">${ic('check')}</span><code>roof_in_frame()</code><span class="res">5 clips · 1,284 fr</span></div>
            <div class="step pending"><span class="st wait">${ic('clock')}</span><code>filter_timeline(5)</code><span class="res">needs approval</span></div>
            <div class="approve"><button class="btn sm pri" id="fApprove">${ic('check')}Approve</button><button class="btn sm ghost">Skip</button><span class="sp"></span><span>Changes your timeline</span></div>
          </div>
          <p>T-02's roof is in frame in <b>5 clips</b>. <b>DJI_0789</b> has the best view: the whole roof stays in frame for all 11 s, from 104 m and about 300 m out, so the dome is seen at a 20° grazing angle.</p>
          <div class="results">
            <div class="res-i best" data-clip="dji0789"><span class="th" style="background-image:url(${A}alzour/clip_dji0789_tanks_poster.jpg)"></span><span><b>DJI_0789 · best</b><span>15:11:16 to :27 · 330 frames</span></span>${ic('play', 'sm go')}</div>
            <div class="res-i" data-clip="dji0665"><span class="th" style="background-image:url(${A}alzour/clip_dji0665_overview_poster.jpg)"></span><span><b>DJI_0665</b><span>13:32:47 to :58 · far, 750 m</span></span>${ic('play', 'sm go')}</div>
          </div>
          <p style="color:var(--tx-3);font-size:12px">Also: pano DJI_0790 (143 m, directly above) and 2 mapping passes. DJI_0712 passes within 800 m but the gimbal points at the jetty.</p>
        </div>`,
      placeholder: 'Ask about this view, or type / for tools'
    });
    $$('#fAgent .res-i').forEach(r => r.addEventListener('click', () => this.setClip(CLIPS.find(c => c.id === r.dataset.clip))));
    agentApprove('#fApprove');
  },
  toggle() {
    this.playing = !this.playing;
    if (this.playing) this.vid.play().catch(() => {}); else this.vid.pause();
    $('#fPlay').innerHTML = ic(this.playing ? 'pause' : 'play', 'sm');
  },
  miniInit() {
    const el = $('#fMini');
    const c = this.miniC = document.createElement('canvas'); c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    el.prepend(c);
  },
  miniDraw(pos, corners) {
    const c = this.miniC, el = c.parentElement;
    const w = el.clientWidth, h = el.clientHeight, dpr = Math.min(devicePixelRatio, 2);
    if (!w) return;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#121518'; x.fillRect(0, 0, w, h);
    const span = 900; const s = w / span;
    const cx = pos[0] + 120, cz = pos[2];
    const M = (X, Z) => [(X - cx) * s + w / 2, (Z - cz) * s + h / 2];
    // street map (axis aligned)
    const [sx0, sy0] = M(-3100, -3500), [sx1, sy1] = M(3500, 3040);
    x.drawImage(this.streetCanvas, sx0, sy0, sx1 - sx0, sy1 - sy0);
    // ortho (affine from three corners)
    const C = this.orthoJ.placement_xz, im = this.orthoImg;
    const [ax, ay] = M(...C.top_left), [bx, by] = M(...C.top_right), [dx, dy] = M(...C.bottom_left);
    x.save();
    x.setTransform(dpr * (bx - ax) / im.width, dpr * (by - ay) / im.width, dpr * (dx - ax) / im.height, dpr * (dy - ay) / im.height, dpr * ax, dpr * ay);
    x.globalAlpha = 0.95; x.drawImage(im, 0, 0);
    x.restore();
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    // path
    const smp = this.clip.samples;
    x.lineWidth = 2.5; x.lineCap = 'round';
    for (let i = 1; i < smp.length; i++) {
      const [x0, y0] = M(smp[i - 1].pos[0], smp[i - 1].pos[2]), [x1, y1] = M(smp[i].pos[0], smp[i].pos[2]);
      x.strokeStyle = '#' + rampColor(lerp(dayF(this.clip.t0), dayF(this.clip.t0 + 11), i / smp.length)).getHexString();
      x.beginPath(); x.moveTo(x0, y0); x.lineTo(x1, y1); x.stroke();
    }
    // footprint
    if (corners) {
      x.beginPath(); corners.forEach((p, i) => { const [a, b] = M(p.x, p.z); i ? x.lineTo(a, b) : x.moveTo(a, b); }); x.closePath();
      x.fillStyle = 'rgba(205,255,90,0.16)'; x.fill(); x.strokeStyle = 'rgba(215,255,106,0.9)'; x.lineWidth = 1; x.stroke();
    }
    // T-02 ring
    const [tx, ty] = M(TANKS['T-02'][0], TANKS['T-02'][2]);
    x.beginPath(); x.arc(tx, ty, 50 * s, 0, 7); x.strokeStyle = 'rgba(215,255,106,0.9)'; x.lineWidth = 1.5; x.stroke();
    x.fillStyle = 'rgba(240,244,248,0.9)'; x.font = '500 10px Geist Mono'; x.fillText('T-02', tx + 50 * s + 4, ty + 3);
    // drone
    const [px, py] = M(pos[0], pos[2]);
    x.beginPath(); x.arc(px, py, 5, 0, 7); x.fillStyle = '#d7ff6a'; x.fill(); x.lineWidth = 2; x.strokeStyle = '#111'; x.stroke();
    // scale bar
    x.fillStyle = 'rgba(16,18,22,0.8)'; x.fillRect(8, h - 24, 92, 16);
    x.strokeStyle = '#cfd6de'; x.lineWidth = 1; x.beginPath(); x.moveTo(12, h - 12); x.lineTo(12, h - 15); x.moveTo(12, h - 12); x.lineTo(12 + 200 * s, h - 12); x.lineTo(12 + 200 * s, h - 15); x.stroke();
    x.fillStyle = '#cfd6de'; x.font = '10px Geist Mono'; x.fillText('200 m', 16 + 200 * s, h - 11);
  },
  loop() {
    if (this._raf || !this.on || !this.ready) return;
    const tick = () => {
      this._raf = null;
      if (!this.on) return;
      this._raf = raf(tick);
      this.frame();
    };
    this._raf = raf(tick);
  },
  frame() {
    const { r, cam, scene, fx, vid, clip } = this;
    const stage = $('#fStage');
    if (!fitRenderer(r, cam, stage)) return;
    const t = vid.currentTime || 0;
    const sm = sampleAt(clip.samples, t);
    const pos = new THREE.Vector3(...sm.pos);
    // projector camera = drone camera
    this.pcam.position.copy(pos); this.pcam.quaternion.copy(sm.q); this.pcam.updateMatrixWorld(); this.pcam.matrixWorldInverse.copy(this.pcam.matrixWorld).invert();
    if (vid.readyState >= 2 && !vid.paused) this.vtex.needsUpdate = true;
    const U = this.proj.uniforms;
    U.camView.value.copy(this.pcam.matrixWorldInverse);
    U.projPV.value.multiplyMatrices(this.pcam.projectionMatrix, this.pcam.matrixWorldInverse);
    U.camPos.value.copy(pos);
    // frustum to ground
    const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => {
      const d = new THREE.Vector3(a, b, 0.5).unproject(this.pcam).sub(pos).normalize();
      const k = d.y < -0.02 ? (0.3 - pos.y) / d.y : 700;
      return pos.clone().addScaledVector(d, Math.min(k, 900));
    });
    setFrustum(this.fr, pos, corners);
    this.drone.position.copy(pos);
    const yaw = -(sm.a.az_deg) * Math.PI / 180;
    this.drone.rotation.set(0, yaw + Math.PI / 2, 0);
    this.drop.geometry.setFromPoints([pos, new THREE.Vector3(pos.x, 0.5, pos.z)]); this.drop.computeLineDistances();
    // camera modes
    if (this.mode === 'follow') {
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(sm.q).setY(0).normalize();
      cam.position.lerp(pos.clone().addScaledVector(back, 180).add(new THREE.Vector3(0, 70, 0)), 0.1);
      cam.lookAt(pos.clone().add(new THREE.Vector3(0, -30, 0)).addScaledVector(back, -120));
      cam.fov = 38; cam.updateProjectionMatrix();
    } else if (this.mode === 'eye') {
      cam.position.copy(pos); cam.quaternion.copy(sm.q); cam.fov = this.pcam.fov; cam.updateProjectionMatrix();
    } else { if (cam.fov !== 38) { cam.fov = 38; cam.updateProjectionMatrix(); } this.ctl.update(); }
    // depth from projector
    this.drone.visible = this.mode !== 'eye';
    r.setRenderTarget(this.rt); r.clear(); scene.overrideMaterial = this.depthMat; r.render(scene, this.pcam); scene.overrideMaterial = null; r.setRenderTarget(null);
    r.clear();
    r.render(scene, cam);
    scene.overrideMaterial = this.proj; const bg = scene.background; scene.background = null;
    r.render(scene, cam);
    scene.overrideMaterial = null; scene.background = bg;
    r.render(fx, cam);
    // overlays
    drawGizmo($('#fGizmo'), cam);
    const L = this.labels;
    const p2 = project(new THREE.Vector3(TANKS['T-02'][0], 60, TANKS['T-02'][2]), cam, stage);
    L.t2.style.display = p2.vis ? '' : 'none'; L.t2.style.left = p2.x + 'px'; L.t2.style.top = p2.y + 'px';
    const pd = project(pos.clone().add(new THREE.Vector3(0, 12, 0)), cam, stage);
    L.drone.style.display = pd.vis && this.mode !== 'eye' ? '' : 'none'; L.drone.style.left = pd.x + 'px'; L.drone.style.top = pd.y + 'px';
    L.drone.querySelector('[data-l="da"]').textContent = fmt(pos.y, 0) + ' m AGL';
    // hud + timeline
    const i = sm.i, tel = clip.tel[i];
    const fr = Math.floor((t % 1) * clip.fps);
    updHud(this.hud, { alt: pos.y, spd: tel.spd, gim: sm.a.gimbal_pitch_deg, hdg: sm.a.az_deg, tc: `${hms(clip.t0 + t)}:${pad(fr)}`, dist: fmt(new THREE.Vector3(...TANKS['T-02']).distanceTo(pos), 0) + ' m to T-02' });
    $('#fVScrub').style.width = (t / (vid.duration || 11)) * 100 + '%';
    $('#fTc').innerHTML = `${hms(clip.t0 + t)}.${pad((t % 1) * 100)} <small>/ clip ${pad(t)}.${pad((t % 1) * 100)} of 11.00</small>`;
    this.tl.set(t);
    // geo readout (plant grid to WGS84 approx around site origin)
    const E = pos.x + 1300, N = -pos.z + 450;
    $('#fCoord').textContent = `E ${fmt(E, 1)}  N ${fmt(N, 1)}  EL ${fmt(pos.y + 100, 1)} · plant grid`;
    if (!this._mt || performance.now() - this._mt > 66) { this._mt = performance.now(); this.miniDraw(sm.pos, corners); }
  }
};

/* =========================================================== AGENT PANEL */
function agentPanel(o) {
  return `
    <div class="agent-h"><span class="ag">${ic('agent', 'sm')}</span><span class="t"><b>${o.title}</b><span>${o.sub}</span></span>
      <span class="acts"><button class="icbtn" data-tip="History">${ic('clock', 'sm')}</button><button class="icbtn" data-tip="Detach to window">${ic('max', 'sm')}</button><button class="icbtn" data-tip="Close">${ic('x', 'sm')}</button></span></div>
    <div class="ctx">${o.ctx.map(([i, k, v]) => `<span class="c">${ic(i)}${k} <b>${v}</b></span>`).join('')}</div>
    <div class="convo">${o.body}</div>
    <div class="composer"><textarea placeholder="${o.placeholder}" rows="2"></textarea>
      <div class="row"><button class="icbtn" data-tip="Attach current frame">${ic('clip', 'sm')}</button><button class="icbtn" data-tip="Tools">${ic('settings', 'sm')}</button><span class="model">${ic('lock', 'xs')}Sends text and 1 frame</span><span class="meterx">2.1 k tok</span><button class="send" aria-label="Send">${ic('send', 'sm')}</button></div></div>`;
}
function agentApprove(sel) {
  const b = $(sel);
  b?.addEventListener('click', () => {
    const steps = b.closest('.steps');
    const st = steps.querySelector('.step.pending');
    st.classList.remove('pending'); st.querySelector('.st').className = 'st done'; st.querySelector('.st').innerHTML = ic('check');
    st.querySelector('.res').textContent = 'applied';
    b.closest('.approve').innerHTML = `<span style="color:var(--ok);display:inline-flex;gap:6px;align-items:center">${ic('check', 'xs')}Applied</span><span class="sp"></span><button class="btn sm ghost">${ic('undo')}Undo</button>`;
  });
}

/* =========================================================== INSPECTION: HCL TANK */
const HCL_ISSUES = [
  ['F01', 5, 'Crack in bottom plate', 'Bottom plate · leak', 'pvm'],
  ['F02', 4, 'Top plate patch damage', 'Roof · 348°', 'pvm'],
  ['F03', 4, 'Lining disbondment at N3', 'Nozzle N3 · 210°', 'pm'],
  ['F08', 4, 'Lining tear at manhole M1', 'Shell · 95°', 'pm'],
  ['F04', 3, 'Top plate blisters', 'Roof crown', 'pvm'],
  ['F05', 3, 'Top plate corrosion', 'Roof · 152°', 'pvm'],
  ['F06', 3, 'Top ring joint blisters', 'Roof to shell', 'pm'],
  ['F07', 3, 'Shell course 2 blisters', 'Shell · 40°', 'pm'],
  ['F09', 3, 'Vertical joint 3 o’clock', 'Shell · 7.6°', 'pm'],
  ['F10', 3, 'Seam LS-2A blistering', 'Shell · 260°', 'm'],
  ['F11', 3, 'Bottom plate pitting near sump', 'Bottom', 'pm']
];
const INS = {
  on: false, started: false, mode: 'orbit', frameT: 1.0,
  active(on) {
    this.on = on;
    if (on && !this.started) this.start().catch(e => { this.err = e.message + ' ' + e.stack; console.error('start failed', e); });
    if (on) this.loop();
    else if (this.vid) this.vid.pause();
  },
  async start() {
    this.started = true;
    const r = this.r = makeRenderer($('#iCanvas'));
    const scene = this.scene = new THREE.Scene();
    scene.background = OK('oklch(0.15 0.008 250)');
    const cam = this.cam = new THREE.PerspectiveCamera(34, 1, 0.05, 200);
    cam.position.set(-10.8, 16.5, -12.6);
    const ctl = this.ctl = new OrbitControls(cam, r.domElement);
    ctl.target.set(0.4, 5.3, 0.2); ctl.enableDamping = true; ctl.update();
    scene.add(new THREE.HemisphereLight(0xe6edf6, 0x2a2622, 1.5));
    const sun = new THREE.DirectionalLight(0xfff4e6, 2.0); sun.position.set(-8, 14, -6); scene.add(sun);
    // ground grid
    const grid = new THREE.GridHelper(16, 16, 0x3a4048, 0x262a30); grid.position.y = -0.31; scene.add(grid);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(8, 64), new THREE.MeshBasicMaterial({ color: OK('oklch(0.18 0.008 250)'), toneMapped: false }));
    disc.rotation.x = -Math.PI / 2; disc.position.y = -0.32; scene.add(disc);

    // section plane keeps x >= -0.25 (cut faces the camera)
    const cut = this.cut = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0.25);
    const gl = await loadGLB('hcl/tank.glb');
    const tank = this.tank = gl.scene;
    const meshes = [];
    tank.traverse(o => {
      if (o.isMesh) {
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.material = o.material.clone();
        o.material.clippingPlanes = [cut]; o.material.clipShadows = true; o.material.side = THREE.DoubleSide;
        if (/Access_Indicative/.test(o.parent?.name || '')) o.visible = false;
        const mn = o.material.name || '';
        if (mn === 'Paint_Shell') { o.material.color.set(0x7d848d); o.material.roughness = 0.7; }
        if (/Rubber_Lining/.test(mn)) { o.material.color.set(0x2c3036); }
        meshes.push(o);
      }
    });
    scene.add(tank);
    this.meshes = meshes;

    // LiDAR cloud
    const buf = await (await fetch(A + 'hcl/cloud.bin')).arrayBuffer();
    const N = 280000, q = new Int16Array(buf, 0, N * 3), inten = new Uint8Array(buf, N * 6, N);
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const cA = OK('oklch(0.3 0.04 260)'), cB = OK('oklch(0.6 0.08 220)'), cC = OK('oklch(0.9 0.12 150)'), cc = new THREE.Color();
    let n = 0;
    for (let i = 0; i < N; i++) {
      const X = q[i * 3] * 0.001, Z = q[i * 3 + 2] * 0.001;
      const R2 = X * X + Z * Z, Y = q[i * 3 + 1] * 0.001; if (R2 > 1.975 * 1.975 || Y > 8.0 + 0.72 * (1 - R2 / 4)) continue;
      pos[n * 3] = X; pos[n * 3 + 1] = q[i * 3 + 1] * 0.001; pos[n * 3 + 2] = Z;
      const f = inten[i] / 255; f < 0.6 ? cc.copy(cA).lerp(cB, f / 0.6) : cc.copy(cB).lerp(cC, (f - 0.6) / 0.4);
      col[n * 3] = cc.r; col[n * 3 + 1] = cc.g; col[n * 3 + 2] = cc.b; n++;
    }
    for (let i = 0; i < 0; i++) {
      pos[i * 3] = q[i * 3] * 0.001; pos[i * 3 + 1] = q[i * 3 + 1] * 0.001; pos[i * 3 + 2] = q[i * 3 + 2] * 0.001;
      const f = inten[i] / 255; f < 0.6 ? cc.copy(cA).lerp(cB, f / 0.6) : cc.copy(cB).lerp(cC, (f - 0.6) / 0.4);
      col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3)); pg.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, n * 3), 3));
    const cloud = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.02, vertexColors: true, sizeAttenuation: true, toneMapped: false, clippingPlanes: [cut] }));
    scene.add(cloud);

    // video projection overlay (f-theta lens)
    const vid = this.vid = $('#iVid');
    vid.src = A + 'hcl/clip_f110_external.mp4'; vid.poster = A + 'hcl/clip_f110_external_poster.jpg';
    const vt = new THREE.VideoTexture(vid); vt.colorSpace = THREE.SRGBColorSpace;
    const rt = this.rt = new THREE.WebGLRenderTarget(1024, 1024);
    rt.depthTexture = new THREE.DepthTexture(1024, 1024); rt.depthTexture.type = THREE.UnsignedIntType;
    this.pcam = new THREE.PerspectiveCamera(140, 1, 0.2, 30);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const proj = this.proj = projectorMaterial({ lens: 'ftheta', aspect: 16 / 9, thetaHalf: 57 * Math.PI / 180, facing: true, maxDist: 16, depthTex: rt.depthTexture, bias: 0.06 });
    proj.uniforms.near.value = 0.2; proj.uniforms.far.value = 30;
    proj.uniforms.map.value = vt; proj.clippingPlanes = [cut]; proj.uniforms.opacity.value = 0.97;
    const projGroup = new THREE.Group();
    meshes.forEach(m => {
      if (!/Shell_Course|Roof_Head_Outer|Roof_Straight|Nozzle|N\d|Manhole|Attach|Seam_.*_Out/i.test(m.name + ' ' + (m.parent?.name || ''))) return;
      m.updateWorldMatrix(true, false);
      // make sure normals point outward (some parts are wound inward)
      let g = m.geometry; const P = g.attributes.position, Nn = g.attributes.normal; let acc = 0; const v = new THREE.Vector3(), nn = new THREE.Vector3();
      for (let i = 0; i < P.count; i += Math.max(1, Math.floor(P.count / 200))) { v.fromBufferAttribute(P, i).applyMatrix4(m.matrixWorld); nn.fromBufferAttribute(Nn, i).transformDirection(m.matrixWorld); acc += nn.dot(v.sub(new THREE.Vector3(0, 4.2, 0))); }
      if (acc < 0) { g = g.clone(); const a = g.attributes.normal; for (let i = 0; i < a.count; i++) a.setXYZ(i, -a.getX(i), -a.getY(i), -a.getZ(i)); }
      const o = new THREE.Mesh(g, proj); o.matrixAutoUpdate = false; o.matrix.copy(m.matrixWorld); o.renderOrder = 2; projGroup.add(o);
    });
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(7.5, 64).rotateX(-Math.PI / 2).translate(0, -0.3, 0), proj);
    gnd.renderOrder = 2; projGroup.add(gnd);
    scene.add(projGroup);
    const inner = new THREE.PointLight(0xdfe7f0, 6, 9, 1.5); inner.position.set(0.6, 5, 0.2); scene.add(inner);

    // poses, path ribbons, drone cage, frustum
    const pj = this.pose = await loadJSON('hcl/clip_f110_external_pose.json');
    const pr = await loadJSON('hcl/clip_f108_roof_pose.json');
    this.tel = telemetry(pj.samples);
    scene.add(ribbon(pj.samples.map(s => s.pos), 0.15, 1, 0.025));
    scene.add(curtain(pj.samples.filter((_, i) => i % 2 === 0).map(s => s.pos), 0.15, 1, -0.3, 0.07));
    scene.add(ribbon(pr.samples.map(s => s.pos), 0.0, 0.45, 0.018, 0.6));
    this.cage = eliosCage(0.24); scene.add(this.cage);
    this.fr = frustumLines(); scene.add(this.fr);

    // issue pins from findings.json
    const fj = await loadJSON('hcl/findings.json');
    this.findings = fj.photos;
    const sevCol = { 3: 'oklch(0.84 0.155 85)', 4: 'oklch(0.74 0.17 52)', 5: 'oklch(0.64 0.215 26)' };
    fj.photos.forEach(f => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshBasicMaterial({ color: OK(sevCol[f.severity]), toneMapped: false, depthTest: false }));
      m.position.fromArray(f.location.pos_m); m.renderOrder = 5; scene.add(m);
    });

    // HUD, timeline, issues, sightings, agent
    this.hud = buildHud($('#iHud'));
    this.hud.name.textContent = 'F110';
    this.hud.date.textContent = '22 NOV 2023';
    this.hud.altu.textContent = 'm above base';
    this.hud.gnss.textContent = 'NO GNSS · LIDAR SLAM';
    this.hud.bat.textContent = '71%';
    this.tl = buildTimeline($('#iTl'), {
      dur: 11, tel: this.tel, evLabel: 'Annotations', minSpan: 0.3,
      events: [{ lbl: 'F02 sighting', a: 0, b: 2.6, cls: 'hit' }, { lbl: 'F12 draft', a: 0.85, b: 1.15, cls: 'on' }, { lbl: 'F04', a: 0, b: 5.2, cls: 'hit', row: null }].slice(0, 2),
      label: t => `00:${pad(50 + t)}`
    });
    this.labels = {
      f02: this.label('issue', `<span class="dot"></span><span class="id">F02</span>Patch damage, inside`, sevCol[4]),
      f12: this.label('issue draft', `<span class="dot"></span><span class="id">F12</span>Draft from video · S4`, sevCol[4]),
      drone: this.label('', `<span class="id">F110</span><span data-l="da">10.6 m</span>`)
    };
    this.renderIssues(); this.renderFlights(); this.renderAgent();
    $('#iLoad').remove();
    $('#iPlay').addEventListener('click', () => {
      if (vid.paused) { vid.play(); $('#iBox').style.display = 'none'; $('#iCur').style.display = 'none'; $('#iF02m').style.display = 'none'; $('#iPlay').innerHTML = ic('pause', 'sm'); }
      else { vid.pause(); $('#iPlay').innerHTML = ic('play', 'sm'); }
    });
    $$('[data-icam]').forEach(b => b.addEventListener('click', () => { $$('[data-icam]').forEach(x => x.classList.toggle('on', x === b)); this.mode = b.dataset.icam; ctl.enabled = this.mode === 'orbit'; }));
    vid.addEventListener('loadeddata', () => { vid.currentTime = this.frameT; }, { once: true });
    vid.addEventListener('seeked', () => this.sightings(), { once: true });
    vid.load();
    this.placeBox();
    this.ready = true; this.loop();
  },
  label(cls, html, c) {
    const d = document.createElement('div'); d.className = 'label3d ' + cls; if (c) d.style.setProperty('--c', c);
    d.innerHTML = `<span class="tag">${html}</span><span class="stem"></span>`;
    $('#iLabels').appendChild(d); return d;
  },
  // back-project the drawn box centre through the f-theta lens onto the tank mesh
  placeBox() {
    const box = { x: 0.405, y: 0.505, w: 0.115, h: 0.2 };
    Object.assign($('#iBox').style, { left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' });
    $('#iCur').style.left = (box.x + box.w) * 100 + '%'; $('#iCur').style.top = (box.y + box.h) * 100 + '%';
    const sm = sampleAt(this.pose.samples, this.frameT);
    const u = (box.x + box.w / 2) * 2 - 1, v = 1 - (box.y + box.h / 2) * 2;
    const yy = v / (16 / 9), rr = Math.hypot(u, yy), th = rr * 57 * Math.PI / 180, ph = Math.atan2(yy, u);
    const dir = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th)).applyQuaternion(sm.q);
    const rc = new THREE.Raycaster(new THREE.Vector3(...sm.pos), dir.normalize());
    const hits = rc.intersectObjects(this.meshes.filter(m => m.visible), false);
    const hit = hits[0];
    this.f12 = hit ? hit.point.clone() : new THREE.Vector3(1.5, 8.6, -0.6);
    const n = hit?.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    // dashed patch on the mesh
    const ringG = new THREE.RingGeometry(0.17, 0.2, 48);
    const patch = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({ color: OK('oklch(0.74 0.17 52)'), toneMapped: false, side: THREE.DoubleSide, depthTest: false, transparent: true }));
    patch.position.copy(this.f12).addScaledVector(n, 0.01); patch.lookAt(this.f12.clone().add(n)); patch.renderOrder = 6;
    const fill = new THREE.Mesh(new THREE.CircleGeometry(0.17, 48), new THREE.MeshBasicMaterial({ color: OK('oklch(0.74 0.17 52)'), transparent: true, opacity: 0.22, toneMapped: false, depthTest: false, side: THREE.DoubleSide }));
    fill.position.copy(patch.position); fill.quaternion.copy(patch.quaternion); fill.renderOrder = 6;
    // ray from drone to hit
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...sm.pos), this.f12]), new THREE.LineDashedMaterial({ color: 0xffb36b, dashSize: 0.12, gapSize: 0.08, toneMapped: false }));
    ray.computeLineDistances();
    this.scene.add(patch, fill, ray);
    const f02 = this.findings.find(f => f.finding_id === 'F02');
    this.f02 = new THREE.Vector3(...f02.location.pos_m);
    // F02 seen through the plate from this frame (f-theta forward projection)
    const cv = this.f02.clone().sub(new THREE.Vector3(...sm.pos)).applyQuaternion(sm.q.clone().invert());
    const dn = cv.clone().normalize(), th2 = Math.acos(-dn.z), ph2 = Math.atan2(dn.y, dn.x), r2 = th2 / (57 * Math.PI / 180);
    const mu = 0.5 + 0.5 * r2 * Math.cos(ph2), mv = 0.5 - 0.5 * r2 * Math.sin(ph2) * 16 / 9;
    Object.assign($('#iF02m').style, { left: mu * 100 + '%', top: mv * 100 + '%' });
    this.dist = this.f12.distanceTo(this.f02);
    const bearing = (Math.atan2(this.f12.z, this.f12.x) * 180 / Math.PI + 360) % 360;
    this.f12info = { bearing, el: this.f12.y };
    $$('[data-f12d]').forEach(e => (e.textContent = fmt(this.dist, 2) + ' m'));
    $$('[data-f12b]').forEach(e => (e.textContent = `${Math.round(bearing)}°, EL ${fmt(this.f12.y, 2)} m`));
  },
  sightings() {
    const v = this.vid;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const x = c.getContext('2d');
    // crop around the box (with margin)
    const bx = 0.405, by = 0.505, bw = 0.115, bh = 0.2, m = 0.06;
    const sx = (bx - m) * v.videoWidth, sy = (by - m) * v.videoHeight, sw = (bw + 2 * m) * v.videoWidth, sh = sw * 9 / 16;
    try {
      x.drawImage(v, sx, sy, sw, sh, 0, 0, 640, 360);
      x.strokeStyle = 'rgb(241,140,60)'; x.lineWidth = 3; x.setLineDash([]);
      x.strokeRect((m / (bw + 2 * m)) * 640, (m * v.videoHeight / sh) * 360, (bw / (bw + 2 * m)) * 640, (bh * v.videoHeight / sh) * 360);
      $('#iCrop').style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.85)})`;
    } catch (e) { }
  },
  renderIssues() {
    const all = [...HCL_ISSUES];
    const counts = { 5: 1, 4: 4, 3: 7 };
    $('#iSevbar').innerHTML = [5, 4, 3].map(s => `<i style="flex:${counts[s]};background:var(--s${s})"></i>`).join('');
    $('#iList').innerHTML = `
      <div class="iss draft sel"><span class="fid" style="color:var(--s4)">F12</span><span class="tt"><b>Coating breakdown over F02 · draft</b><span>Roof exterior · <span data-f12b>…</span></span></span><span class="sev" data-s="4">S4</span></div>` +
      all.map(([id, s, t, z, v]) => `
      <div class="iss"><span class="fid">${id}</span><span class="tt"><b>${t}</b><span>${z}</span></span><span style="display:flex;gap:8px;align-items:center"><span class="views">${v.includes('p') ? ic('photo') : ''}${v.includes('v') ? ic('video') : ''}${v.includes('m') ? ic('cube') : ''}</span><span class="sev" data-s="${s}">S${s}</span></span></div>`).join('');
    $$('#iList .iss').forEach(r => r.addEventListener('click', () => $$('#iList .iss').forEach(x => x.classList.toggle('sel', x === r))));
  },
  renderFlights() {
    const F = [
      ['101', 'Shell pass 1', 'photos/F04_101_0035.jpg', '08:42'], ['102', 'Shell pass 2', null, '09:10'], ['103', 'Shell pass 3', null, '08:55'],
      ['104', 'Nozzles N1 to N5', null, '06:30'], ['105', 'Vertical joints', 'photos/F09_105_0144.jpg', '07:48'], ['106', 'Roof patches', 'photos/F02_106_0172.jpg', '07:05'],
      ['107', 'Roof ring joint', 'photos/F06_107_0186.jpg', '06:12'], ['108', 'Roof, descent', 'clip_f108_roof_poster.jpg', '05:40'], ['109', 'Bottom plate', 'photos/F01_109_0256.jpg', '09:31'],
      ['110', 'External, roof top', 'clip_f110_external_poster.jpg', '01:58']
    ];
    $('#iFlist').innerHTML = F.reverse().map(([id, t, th, d]) => `<div class="fl ${id === '110' ? 'on' : ''}"><span class="th" style="${th ? `background-image:url(${A}hcl/${th})` : 'background:repeating-linear-gradient(135deg,var(--bg-2) 0 5px,var(--bg-3) 5px 6px)'}"><span class="rib"></span></span><span class="tt"><b>Flight ${id} · ${t}</b><span>${id === '110' ? 'Outside · 11 s clip' : 'Inside · Elios 3 · LiDAR'}</span></span><span class="d">${d}</span></div>`).join('');
  },
  renderAgent() {
    $('#iAgent').innerHTML = agentPanel({
      title: 'Agent · Video, flight 110', sub: 'Attached to the video window',
      ctx: [['video', 'Frame', '30 · 00:51.00'], ['box', 'Selection', 'box, draft F12'], ['issues', 'Nearby', 'F02']],
      body: `
        <div class="msg-u">Is what I just boxed the same defect as F02?</div>
        <div class="msg-a">
          <div class="who">${ic('agent')}Agent · 3 steps</div>
          <div class="steps">
            <div class="step"><span class="st done">${ic('check')}</span><code>back_project(box, f-theta)</code><span class="res">roof, <span data-f12b></span></span></div>
            <div class="step"><span class="st done">${ic('check')}</span><code>nearest_issue(3D)</code><span class="res">F02 · <span data-f12d></span></span></div>
            <div class="step pending"><span class="st wait">${ic('clock')}</span><code>link_sighting(F12 → F02)</code><span class="res">needs approval</span></div>
            <div class="approve"><button class="btn sm pri" id="iApprove">${ic('link')}Link to F02</button><button class="btn sm ghost">Keep as F12</button></div>
          </div>
          <p>Probably the same defect seen from outside. Your box lands on the roof plate <b data-f12d></b> from F02 (patch damage, S4, found from inside on flight 106). Rust run-off outside over an internal patch suggests the plate is weeping through.</p>
          <p style="color:var(--tx-3);font-size:12px">If you link it, F02 gets a 3rd sighting (photo, mesh, this frame) and the note is drafted for your review.</p>
        </div>`,
      placeholder: 'Ask about this frame'
    });
    agentApprove('#iApprove');
    $('#iPhotoB').innerHTML = `
      <div class="sight"><div class="ph" id="iCrop" style="background-image:url(${A}hcl/clip_f110_external_poster.jpg)"></div><div class="cap">${ic('video', 'xs')}<b>Video</b> F110 · frame 30<span class="sev" data-s="4" style="margin-left:auto">F12</span></div></div>
      <div class="sight"><div class="ph" style="background-image:url(${A}hcl/photos/F02_106_0172.jpg)"></div><div class="cap">${ic('photo', 'xs')}<b>Photo</b> 106_0172 · inside<span class="sev" data-s="4" style="margin-left:auto">F02</span></div></div>`;
  },
  loop() {
    if (this._raf || !this.on || !this.ready) return;
    const tick = () => { this._raf = null; if (!this.on) return; this._raf = raf(tick); this.frame(); };
    this._raf = raf(tick);
  },
  frame() {
    const { r, cam, scene, vid } = this;
    const stage = $('#iStage');
    if (!fitRenderer(r, cam, stage)) return;
    const t = vid.currentTime || 0;
    const sm = sampleAt(this.pose.samples, t);
    const pos = new THREE.Vector3(...sm.pos);
    const m = new THREE.Matrix4().compose(pos, sm.q, new THREE.Vector3(1, 1, 1)).invert();
    if (vid.readyState >= 2 && (!vid.paused || this._lastT !== vid.currentTime || (this._pf = (this._pf || 0) + 1) < 20)) { this.proj.uniforms.map.value.needsUpdate = true; if (this._lastT !== vid.currentTime) this._pf = 0; this._lastT = vid.currentTime; }
    const U = this.proj.uniforms; U.camView.value.copy(m); U.camPos.value.copy(pos);
    this.pcam.position.copy(pos); this.pcam.quaternion.copy(sm.q); this.pcam.updateMatrixWorld(); this.pcam.matrixWorldInverse.copy(this.pcam.matrixWorld).invert();
    U.projPV.value.multiplyMatrices(this.pcam.projectionMatrix, this.pcam.matrixWorldInverse);
    const vis = []; scene.traverse(o => { if ((o.isPoints || o.isLine || o.isLineSegments || o.material === this.proj || o.material?.vertexColors || o === this.cage) && o.visible) { vis.push(o); o.visible = false; } });
    scene.overrideMaterial = this.depthMat; r.setRenderTarget(this.rt); r.clear(); r.render(scene, this.pcam); r.setRenderTarget(null); scene.overrideMaterial = null;
    vis.forEach(o => (o.visible = true));
    this.cage.position.copy(pos); this.cage.quaternion.copy(sm.q);
    // f-theta frustum (4 image corners at 1.6 m)
    const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([u, v]) => {
      const yy = v / (16 / 9), rr = Math.hypot(u, yy), th = Math.min(rr * 57, 80) * Math.PI / 180, ph = Math.atan2(yy, u);
      return new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), -Math.cos(th)).applyQuaternion(sm.q).multiplyScalar(1.4).add(pos);
    });
    setFrustum(this.fr, pos, corners);
    if (this.mode === 'eye') { cam.position.copy(pos); cam.quaternion.copy(sm.q); cam.fov = 75; cam.updateProjectionMatrix(); this.cage.visible = false; }
    else if (this.mode === 'follow') { this.cage.visible = true; const back = new THREE.Vector3(0, 0, 1).applyQuaternion(sm.q); cam.position.lerp(pos.clone().addScaledVector(back, 3.5).add(new THREE.Vector3(0, 1.2, 0)), 0.1); cam.lookAt(this.f12 || pos); cam.fov = 40; cam.updateProjectionMatrix(); }
    else { this.cage.visible = true; if (cam.fov !== 34) { cam.fov = 34; cam.updateProjectionMatrix(); } this.ctl.update(); }
    r.render(scene, cam);
    drawGizmo($('#iGizmo'), cam);
    const L = this.labels;
    const place = (el, v, dy = 0) => { const p = project(v.clone().add(new THREE.Vector3(0, dy, 0)), cam, stage); el.style.display = p.vis ? '' : 'none'; el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; };
    if (this.f02) { place(L.f02, this.f02, 0.0); L.f02.style.transform = 'translate(10px, -50%)'; L.f02.querySelector('.stem').style.display = 'none'; }
    if (this.f12) place(L.f12, this.f12, 0.25);
    place(L.drone, pos, 0.35);
    L.drone.querySelector('[data-l="da"]').textContent = fmt(pos.y, 1) + ' m';
    const tel = this.tel[sm.i];
    const qd = new THREE.Quaternion().fromArray(sm.a.q_drone);
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(qd);
    const hdg = (Math.atan2(fwd.z, fwd.x) * 180 / Math.PI + 360) % 360;
    const frn = Math.round(t * 29.97);
    updHud(this.hud, { alt: pos.y, spd: tel.spd, gim: -sm.a.servo_deg, hdg, tc: `00:00:${pad(50 + t)}:${pad(frn % 30)}`, dist: fmt(pos.distanceTo(this.f12 || pos), 2) + ' m to box' });
    $('#iVScrub').style.width = (t / 11) * 100 + '%';
    $('#iTc').innerHTML = `00:${pad(50 + t)}.${pad((t % 1) * 100)} <small>/ flight 110 · frame ${frn}</small>`;
    this.tl.set(t);
    $('#iCoord').textContent = `Drone ${Math.round(hdg)}° · ${fmt(pos.y, 2)} m above base · ${fmt(Math.hypot(pos.x, pos.z), 2)} m off axis`;
  }
};

/* =========================================================== SETTINGS */
const SET = {
  done: false,
  init() {
    if (this.done) return; this.done = true;
    $$('#aiMode button').forEach(b => b.addEventListener('click', () => {
      $$('#aiMode button').forEach(x => x.classList.toggle('on', x === b));
      const off = b.textContent.includes('Offline');
      $('#chipAi').innerHTML = off ? `${ic('offline')}AI offline only` : `${ic('agent')}Cloud AI: this project`;
      $('#chipAi').classList.toggle('acc', !off);
    }));
    $$('.switch').forEach(s => s.addEventListener('click', () => s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true')));
    $$('.radio').forEach(r => r.addEventListener('click', () => $$('.radio').forEach(x => x.classList.toggle('on', x === r))));
    $$('.sevm-list button').forEach(b => b.addEventListener('click', () => $$('.sevm-list button').forEach(x => x.classList.toggle('on', x === b))));
    // scroll spy
    const body = $('#setBody');
    const links = $$('#setNav a');
    links.forEach(a => a.addEventListener('click', e => { e.preventDefault(); $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
    body.addEventListener('scroll', () => {
      let id = null;
      $$('.set-sec', body).forEach(s => { if (s.getBoundingClientRect().top - body.getBoundingClientRect().top < 120) id = s.id; });
      if (id) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + id));
    });
    geoReady.then(() => this.cov());
    new ResizeObserver(() => this.cov()).observe($('#mapCov'));
  },
  cov() {
    const el = $('#mapCov');
    const packs = [['Kuwait', 46.55, 28.52, 48.45, 30.1, 1], ['Qatar', 50.7, 24.45, 51.7, 26.2], ['Bahrain', 50.35, 25.75, 50.85, 26.35], ['UAE', 51.5, 22.6, 56.4, 26.1]];
    const r = geoRender(el, [46.3, 22.9, 56.9, 30.4], { road: 0.5, extra: (P) => packs.map(([n, a, b, c, d, upd]) => {
      const [x0, y0] = P(a, d), [x1, y1] = P(c, b);
      return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${upd ? 'oklch(0.885 0.2 128 / 0.10)' : 'oklch(0.76 0.1 235 / 0.07)'}" stroke="${upd ? 'var(--acc)' : 'oklch(0.76 0.1 235 / 0.6)'}" stroke-dasharray="${upd ? '4 3' : ''}"/><text x="${x0 + 5}" y="${y0 + 13}" fill="var(--tx-2)" font-size="10.5" font-family="Archivo">${n}${upd ? ' · 62%' : ''}</text>`;
    }).join('') });
    if (!r) return;
    const cap = '<span class="cap">Installed packs over Natural Earth base · Saudi Arabia and Oman extend beyond view</span>';
    el.innerHTML = r.svg + cap;
  }
};

/* =========================================================== BOOT */
show((location.hash || '#home').slice(1));
addEventListener('hashchange', () => show(location.hash.slice(1)));
