// Offline-style vector basemap from Natural Earth 1:10m (world-atlas), drawn as SVG.
import { geoMercator, geoPath, geoGraticule, geoCircle } from 'https://cdn.jsdelivr.net/npm/d3-geo@3.1.1/+esm';
import { feature, mesh } from 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm';

let worldP = null;
const world = () => worldP || (worldP = fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json').then(r => r.json()).then(t => ({
  countries: feature(t, t.objects.countries).features.filter(c => c.id !== '010'),
  borders: mesh(t, t.objects.countries, (a, b) => a !== b),
})));

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent && parent.appendChild(e); return e; };
const GCC = new Set(['414', '682', '784', '634', '048', '512']);
const REGION = new Set(['414', '682', '784', '634', '048', '512', '368', '364', '400', '887', '760', '818', '586', '004', '795', '232', '729', '262', '706', '422', '376', '792', '031', '051', '268']);
const OVc = 'oklch(0.96 0.008 250)';
const ACC = 'oklch(0.79 0.115 172)';
const fmtLL = (lon, lat) => `${Math.abs(lat).toFixed(4)} ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(4)} ${lon >= 0 ? 'E' : 'W'}`;

export async function drawHomeMap(svg, projects, onSelect, onOpen) {
  const { countries, borders } = await world();
  const draw = () => {
    svg.innerHTML = '';
    const W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    // main view: Kuwait, where five of the six projects sit
    const proj = geoMercator().fitExtent([[0, 60], [W, H + 10]], { type: 'MultiPoint', coordinates: [[47.40, 28.50], [49.05, 29.72]] }).clipExtent([[0, 0], [W, H]]);
    const path = geoPath(proj);
    el('rect', { class: 'sea', x: 0, y: 0, width: W, height: H }, svg);
    el('path', { class: 'grat', d: path(geoGraticule().step([0.25, 0.25]).extent([[44, 26], [52, 32]])()) }, svg);
    const gLand = el('g', {}, svg);
    for (const c of countries) { if (!['414', '682', '368', '364'].includes(c.id)) continue; el('path', { class: 'land' + (GCC.has(c.id) ? ' gcc' : ''), d: path(c) || '' }, gLand); }
    el('path', { class: 'border', d: path(borders) }, svg);
    for (let lat = 28.5; lat <= 29.9; lat += 0.25) { const p = proj([47.4, lat]); if (p[1] > 120 && p[1] < H - 220) el('text', { class: 'gratlbl', x: 8, y: p[1] - 4 }, svg).textContent = `${lat.toFixed(2)}°N`; }
    for (let lon = 47.5; lon <= 49; lon += 0.25) { const p = proj([lon, 28.5]); if (p[0] > 260 && p[0] < W - 250) el('text', { class: 'gratlbl', x: p[0] + 4, y: H - 8 }, svg).textContent = `${lon.toFixed(2)}°E`; }
    const lbl = (txt, lon, lat, cls = 'ctry') => { const p = proj([lon, lat]); const t = el('text', { class: cls, x: p[0], y: p[1], 'text-anchor': 'middle' }, svg); t.textContent = txt; };
    lbl('Kuwait', 47.68, 29.12); lbl('Iraq', 47.62, 29.90); lbl('Saudi Arabia', 48.05, 28.42); lbl('Arabian Gulf', 48.78, 29.62, 'sea-lbl');

    // range rings and bearing ticks from Kuwait City
    const kc = [47.9774, 29.3759], kcp = proj(kc), pxPerKm = Math.abs(proj([kc[0], kc[1] + 1 / 111.2])[1] - kcp[1]);
    for (const km of [25, 50, 75]) {
      el('path', { class: 'ring', d: path(geoCircle().center(kc).radius(km / 111.2).precision(2)()), 'stroke-dasharray': km === 75 ? '' : '3 4' }, svg);
      el('text', { class: 'ringlbl', x: kcp[0] + 4, y: kcp[1] - km * pxPerKm - 5 }, svg).textContent = `${km} km`;
    }
    for (let a = 0; a < 360; a += 10) {
      const r = 75 * pxPerKm, l = a % 30 === 0 ? 9 : 5, s = Math.sin(a * Math.PI / 180), c = -Math.cos(a * Math.PI / 180);
      el('line', { x1: kcp[0] + s * r, y1: kcp[1] + c * r, x2: kcp[0] + s * (r + l), y2: kcp[1] + c * (r + l), stroke: 'oklch(0.96 0.008 250 / .35)' }, svg);
      if (a % 30 === 0) el('text', { class: 'ringlbl', x: kcp[0] + s * (r + 20), y: kcp[1] + c * (r + 20) + 3, 'text-anchor': 'middle', style: a === 0 ? `fill:${ACC}` : '' }, svg).textContent = a === 0 ? 'N' : String(a).padStart(3, '0');
    }
    for (const [n, ar, lon, lat, anchor] of [['Kuwait City', 'مدينة الكويت', 47.9774, 29.3759, 'end'], ['Al Jahra', 'الجهراء', 47.658, 29.337, 'end'], ['Al Ahmadi', 'الأحمدي', 48.083, 29.077, 'end'], ['Al Khiran', 'الخيران', 48.38, 28.66, 'end'], ['Al Wafrah', 'الوفرة', 47.93, 28.64, 'end'], ['Failaka', 'فيلكا', 48.33, 29.44, 'start'], ['Abdali', 'العبدلي', 47.75, 30.0, 'end']]) {
      const p = proj([lon, lat]); if (p[1] < 120) continue; const g = el('g', { class: 'city' }, svg); const dx = anchor === 'end' ? -7 : 7;
      el('circle', { cx: p[0], cy: p[1], r: 2 }, g);
      el('text', { x: p[0] + dx, y: p[1] - 2, 'text-anchor': anchor }, g).textContent = n;
      el('text', { x: p[0] + dx, y: p[1] + 11, 'text-anchor': anchor, style: "font-family:'IBM Plex Sans Arabic';font-size:10px;opacity:.75" }, g).textContent = ar;
    }

    const marker = (g, x, y, p, bx, ly) => {
      const m = el('g', { class: 'pm' + (p.id === 'alzour' ? ' sel' : ''), 'data-id': p.id, tabindex: 0 }, g);
      const bw = 196, bh = 40, right = x > bx + bw / 2;
      const ex = right ? bx + bw : bx, kx = right ? ex + 14 : ex - 14;
      el('path', { class: 'pm-leader', d: `M${x},${y} L${kx},${ly} L${ex},${ly}` }, m);
      el('circle', { class: 'pm-halo', cx: x, cy: y, r: 12 }, m);
      el('rect', { class: 'pm-sym', x: x - 5, y: y - 5, width: 10, height: 10, transform: `rotate(45 ${x} ${y})` }, m);
      el('circle', { class: 'pm-core', cx: x, cy: y, r: 1.8 }, m);
      el('rect', { class: 'pm-box', x: bx, y: ly - bh / 2, width: bw, height: bh, rx: 2 }, m);
      el('text', { class: 'pm-t1', x: bx + 10, y: ly - 3 }, m).textContent = p.name;
      el('text', { class: 'pm-t2', x: bx + 10, y: ly + 12 }, m).textContent = `${p.client} · ${p.type.toUpperCase()} · ${p.size}`;
      m.addEventListener('click', () => onSelect(p.id));
      m.addEventListener('dblclick', () => onOpen(p.id));
    };
    const gm = el('g', {}, svg);
    const colX = W - 24 - 196;
    const rowY = { ring: 29.58, hcl: 29.25, ebsm: 29.02, alzour: 28.80 };
    ['ring', 'hcl', 'ebsm', 'alzour'].forEach(id => {
      const p = projects.find(x => x.id === id); const q = proj(p.ll);
      marker(gm, q[0], q[1], p, colX, proj([48, rowY[id]])[1]);
    });
    { const p = projects.find(x => x.id === 'masafi'); const q = proj(p.ll); marker(gm, q[0], q[1], p, 24, q[1] + 78); }

    // off-screen entity: DAMAC in Dubai, pinned to the edge along its true bearing
    const dm = projects.find(p => p.id === 'damac');
    const brg = 117, dist = 862;
    const ex = W - 16, ey = H - 104;
    const og = el('g', { class: 'pm', 'data-id': 'damac' }, svg);
    el('path', { d: `M${ex},${ey} l-11,-6.5 v13 z`, fill: OVc, opacity: 0.85 }, og);
    el('rect', { class: 'pm-box', x: ex - 230, y: ey - 20, width: 210, height: 40, rx: 2 }, og);
    el('text', { class: 'pm-t1', x: ex - 220, y: ey - 3 }, og).textContent = dm.name;
    el('text', { class: 'pm-t2', x: ex - 220, y: ey + 12 }, og).textContent = `OFF MAP · DUBAI · ${dist} KM · ${brg}°`;
    og.addEventListener('click', () => onSelect('damac'));

    // GCC locator
    const lw = 232, lh = 156, lx0 = 16, ly0 = H - 16 - lh;
    const lp = geoMercator().fitExtent([[lx0 + 8, ly0 + 8], [lx0 + lw - 8, ly0 + lh - 8]], { type: 'MultiPoint', coordinates: [[45.8, 22.6], [57.6, 30.6]] }).clipExtent([[lx0, ly0], [lx0 + lw, ly0 + lh]]);
    const lpath = geoPath(lp);
    const defs = el('defs', {}, svg); const cp = el('clipPath', { id: 'loc' }, defs); el('rect', { x: lx0, y: ly0, width: lw, height: lh }, cp);
    const gl = el('g', { 'clip-path': 'url(#loc)' }, svg);
    el('rect', { x: lx0, y: ly0, width: lw, height: lh, fill: 'oklch(0.125 0.012 240)' }, gl);
    for (const c of countries) if (REGION.has(c.id)) el('path', { d: lpath(c) || '', fill: GCC.has(c.id) ? 'oklch(0.235 0.009 250)' : 'oklch(0.195 0.008 250)', stroke: 'oklch(0.31 0.01 250)', 'stroke-width': 0.5 }, gl);
    const a = lp([47.40, 28.50]), b = lp([49.05, 29.72]);
    el('rect', { x: a[0], y: b[1], width: b[0] - a[0], height: a[1] - b[1], fill: 'oklch(0.79 0.115 172 / .18)', stroke: ACC }, gl);
    const dd = lp(dm.ll);
    el('rect', { x: dd[0] - 3, y: dd[1] - 3, width: 6, height: 6, fill: 'none', stroke: OVc, transform: `rotate(45 ${dd[0]} ${dd[1]})` }, gl);
    el('text', { x: dd[0] - 7, y: dd[1] + 3, 'text-anchor': 'end', style: 'fill:var(--fg-2);font:400 10px var(--f-ui)' }, gl).textContent = 'Dubai';
    el('rect', { x: lx0 + 0.5, y: ly0 + 0.5, width: lw - 1, height: lh - 1, fill: 'none', stroke: 'oklch(0.96 0.008 250 / .28)' }, svg);
    el('text', { x: lx0 + 8, y: ly0 + 16, style: 'fill:var(--fg-2);font:500 10.5px var(--f-cond);letter-spacing:.08em;text-transform:uppercase' }, svg).textContent = 'GCC';

    svg.onmousemove = e => {
      const r = svg.getBoundingClientRect(); const ll = proj.invert([e.clientX - r.left, e.clientY - r.top]);
      const out = document.getElementById('mapCursor'); if (out && ll) out.textContent = fmtLL(ll[0], ll[1]);
    };
  };
  draw();
  new ResizeObserver(() => draw()).observe(svg);
}

export async function drawCoverage(svg) {
  const { countries } = await world();
  const W = 400, H = 300;
  const proj = geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], { type: 'MultiPoint', coordinates: [[44.5, 16.5], [60.5, 31]] }).clipExtent([[0, 0], [W, H]]);
  const path = geoPath(proj);
  const st = { '414': 'ok', '682': 'ok', '634': 'ok', '048': 'ok', '784': 'upd', '512': 'dl' };
  const fill = { ok: 'oklch(0.79 0.115 172 / .30)', upd: 'oklch(0.84 0.14 92 / .28)', dl: 'oklch(0.74 0.08 235 / .28)' };
  const stroke = { ok: 'oklch(0.79 0.115 172 / .8)', upd: 'oklch(0.84 0.14 92 / .8)', dl: 'oklch(0.74 0.08 235 / .8)' };
  el('path', { d: path(geoGraticule().step([5, 5])()), fill: 'none', stroke: 'oklch(0.96 0.008 250 / .06)' }, svg);
  for (const c of countries) {
    if (!REGION.has(c.id)) continue;
    const s = st[c.id];
    el('path', { d: path(c) || '', fill: s ? fill[s] : 'oklch(0.205 0.008 250)', stroke: s ? stroke[s] : 'oklch(0.30 0.01 250)', 'stroke-width': s ? 0.8 : 0.5 }, svg);
  }
  for (const [t, lon, lat] of [['KW', 47.6, 29.3], ['SA', 45.5, 24], ['AE', 54.2, 23.6], ['QA', 51.2, 25.3], ['BH', 50.55, 26.05], ['OM', 56.8, 21.0]]) {
    const p = proj([lon, lat]);
    el('text', { x: p[0], y: p[1], 'text-anchor': 'middle', style: 'fill:var(--fg-0);font:600 10px var(--f-mono)' }, svg).textContent = t;
  }
}
