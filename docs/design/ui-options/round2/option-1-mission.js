// Option 1: Mission. Shell, sidebar, panels, timelines, settings. 3D and maps are lazy modules.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const I = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;
const A = '../../assets/';
const app = $('#app');

/* ------------------------------------------------------------------ data */
const PROJECTS = [
  { id: 'alzour', screen: 2, name: 'Al-Zour LNG Terminal', client: 'KIPIC', site: 'Al-Zour, Kuwait', type: 'LNG plant', glyph: 'plant',
    date: '21 Feb 2023', size: '186 GB', ll: [48.3790, 28.7275], off: 'ready',
    layers: [['scene', '909'], ['cloud', '842M'], ['raster', 'ortho'], ['video', '25'], ['pano', '12']] },
  { id: 'hcl', screen: 3, name: 'HCl Tank 710-D-130335', client: 'KOC', site: 'Mina Al-Ahmadi, Kuwait', type: 'Tank inspection', glyph: 'tank',
    date: '22 Nov 2023', size: '38 GB', ll: [48.1305, 29.0640], off: 'ready',
    layers: [['scene', 'GLB'], ['cloud', '1.4M'], ['video', '10'], ['issues', '11']] },
  { id: 'ebsm', name: 'EBSM Flare Stack', client: 'EQUATE', site: 'Shuaiba, Kuwait', type: 'Flare / stack', glyph: 'flare',
    date: '3 Jun 2026', size: '21 GB', ll: [48.1680, 28.9890], off: 'ready',
    layers: [['scene', '80 m'], ['photo', '299'], ['issues', '78'], ['report', 'PDF']] },
  { id: 'damac', name: 'DAMAC Hills Tower Facade', client: 'DAMAC', site: 'Dubai, UAE', type: 'Building facade', glyph: 'facade',
    date: '11 Mar 2026', size: '64 GB', ll: [55.2470, 25.0290], off: 'partial',
    layers: [['photo', '1,182'], ['issues', '656'], ['report', '206 p']] },
  { id: 'masafi', name: 'Masafi Stockpile Yard', client: 'Masafi', site: 'Sulaibiya, Kuwait', type: 'Stockpiles', glyph: 'pile',
    date: '10 Jan 2021', size: '12 GB', ll: [47.8250, 29.2570], off: 'ready',
    layers: [['raster', 'DSM'], ['cloud', '2 dates'], ['pile', '19']] },
  { id: 'ring', name: '1st Ring Road Survey', client: 'MPW', site: 'Kuwait City, Kuwait', type: 'Road condition', glyph: 'road',
    date: '27 Sep 2026', size: '92 GB', ll: [47.9900, 29.3640], off: 'sync',
    layers: [['raster', '1.25 cm'], ['issues', 'PCI'], ['road', '7.6 km']] },
];

const TREES = {
  alzour: [
    { g: 'Models', ic: 'scene', n: 2, open: true, items: [
      { n: 'Plant model', m: '909 nodes' },
      { n: '20 LNG tanks', l2: true, m: '160' },
      { n: '20-T-0002', l2: true, sel: true, m: 'tank' },
      { n: '30 HP LNG process', l2: true, m: '53' },
      { n: '10 Jetty and berths', l2: true, m: '145' },
      { n: '8 more areas', l2: true, more: true },
    ] },
    { g: 'Point clouds', ic: 'cloud', n: 1, items: [{ n: 'Site LiDAR, thinned', m: '842 M', off: true }] },
    { g: 'Maps and rasters', ic: 'map', n: 3, open: true, items: [
      { n: 'Orthomosaic 2023-02', m: '2 cm' }, { n: 'OSM streets, dark', m: 'offline' }, { n: 'Plot plan AZ-PP-001', m: 'PDF', off: true } ] },
    { g: 'Video', ic: 'video', n: 25, open: true, items: [
      { n: 'DJI_0789 tanks pass', m: '0:11', live: true }, { n: 'DJI_0665 overview', m: '0:11' }, { n: '23 more clips', more: true } ] },
    { g: 'Photos', ic: 'photo', n: 12, items: [{ n: 'Panoramas 360°', m: '12' }] },
    { g: 'Annotations', ic: 'anno', n: 26, items: [{ n: 'Issues', m: '14' }, { n: 'Measurements', m: '6' }, { n: 'Roof visible, draft', m: '6' }] },
  ],
  hcl: [
    { g: 'Models', ic: 'scene', n: 1, open: true, items: [
      { n: 'Tank 710-D-130335', m: '225 nodes' },
      { n: 'Shell, 3 courses', l2: true, m: 'steel' }, { n: 'Rubber lining', l2: true, m: '6 mm' },
      { n: 'Nozzles and manholes', l2: true, m: '15' }, { n: 'Dip pipes N1B, N11', l2: true, m: '2' } ] },
    { g: 'Point clouds', ic: 'cloud', n: 1, open: true, items: [{ n: 'Elios 3 LiDAR, 2 cm', m: '280 k' }] },
    { g: 'Maps and rasters', ic: 'map', n: 1, items: [{ n: 'GA drawing rev 3', m: 'PDF', off: true }] },
    { g: 'Video', ic: 'video', n: 10, open: true, items: [
      { n: 'Flight 110, external', m: '0:11', live: true }, { n: 'Flight 108, roof', m: '0:11' }, { n: '8 more flights', more: true } ] },
    { g: 'Photos', ic: 'photo', n: 492, items: [{ n: 'Finding photos', m: '6' }, { n: 'Extracted frames', m: '486' }] },
    { g: 'Annotations', ic: 'anno', n: 13, open: true, items: [{ n: 'Issues F01 to F11', m: '11' }, { n: 'F12 draft', m: 'new', sev: 4 }, { n: 'Section cut, N half', m: '1' }] },
  ],
};

const HCL_ISSUES = [
  { id: 'F12', t: 'Coating breakdown at roof nozzle', cls: 'Coating breakdown', area: 'Roof, external', el: '8.79', brg: '258', sev: 4, st: 'Draft', draft: true },
  { id: 'F01', t: 'Crack in bottom plate', cls: 'Crack', area: 'Bottom plate', el: '0.04', brg: '342', sev: 5, st: 'Approved', photo: 'F01_109_0256.jpg' },
  { id: 'F02', t: 'Top plate patch damage', cls: 'Patch damage', area: 'Roof', el: '8.48', brg: '348', sev: 4, st: 'Approved', photo: 'F02_106_0172.jpg' },
  { id: 'F03', t: 'Lining disbondment at N3 bore', cls: 'Disbondment', area: 'Nozzle N3', el: '1.21', brg: '96', sev: 5, st: 'Reviewed' },
  { id: 'F04', t: 'Top plate blisters', cls: 'Coating blister', area: 'Roof', el: '8.69', brg: '193', sev: 3, st: 'Approved', photo: 'F04_101_0035.jpg' },
  { id: 'F05', t: 'Top plate corrosion', cls: 'Corrosion', area: 'Roof', el: '8.56', brg: '153', sev: 3, st: 'Approved', photo: 'F05_108_0220.jpg' },
  { id: 'F06', t: 'Top ring joint blisters', cls: 'Coating blister', area: 'Roof to shell joint', el: '8.28', brg: '129', sev: 3, st: 'Approved', photo: 'F06_107_0186.jpg' },
  { id: 'F07', t: 'Lap seam lift at LS-2A', cls: 'Seam lift', area: 'Shell course 2', el: '4.10', brg: '214', sev: 4, st: 'Reviewed' },
  { id: 'F08', t: 'Chemical attack, discoloured lining', cls: 'Chemical attack', area: 'Shell course 1', el: '1.62', brg: '270', sev: 3, st: 'Reviewed' },
  { id: 'F09', t: "Vertical joint 3 o'clock blisters", cls: 'Coating blister', area: 'Shell', el: '4.74', brg: '8', sev: 3, st: 'Approved', photo: 'F09_105_0144.jpg' },
  { id: 'F10', t: 'Blister cluster at CS 5.5 seam', cls: 'Coating blister', area: 'Shell course 2', el: '5.48', brg: '62', sev: 3, st: 'Reviewed' },
  { id: 'F11', t: 'Swelling at bottom-to-shell weld', cls: 'Swelling', area: 'Bottom corner', el: '0.12', brg: '188', sev: 5, st: 'Reviewed' },
];

const SEV_MODEL = [
  { l: 5, name: 'Critical', code: 'TK-5', c: 'var(--s5)', crit: 'Through-wall defect or active leak. Lining breached with substrate attack; loss of containment likely.', act: 'Take out of service. Notify the integrity lead within 24 h.' },
  { l: 4, name: 'High', code: 'TK-4', c: 'var(--s4)', crit: 'Lining damage exposing steel, or damage likely to grow: patch damage, disbondment over 0.1 m², seam lift.', act: 'Repair at the next planned shutdown, within 3 months. Re-inspect the area.', editing: true },
  { l: 3, name: 'Medium', code: 'TK-3', c: 'var(--s3)', crit: 'Local blisters or corrosion without loss of section. No exposed substrate.', act: 'Monitor. Include in the next inspection campaign.' },
  { l: 2, name: 'Low', code: 'TK-2', c: 'var(--s2)', crit: 'Cosmetic defects, staining, minor mechanical marks on the lining surface.', act: 'Record only.' },
  { l: 1, name: 'Observation', code: 'TK-1', c: 'var(--s1)', crit: 'Condition note with no defect, for context in the report.', act: 'None.' },
];

/* ------------------------------------------------------------------ sidebar */
let currentProject = 'alzour';
function renderTree(pid) {
  const tree = TREES[pid];
  $('#tree').innerHTML = tree.map(g => `
    <details class="tgroup" ${g.open ? 'open' : ''}>
      <summary>${I('chev-r', 's12 chev')}${I(g.ic)}<span class="glbl">${g.g}</span><span class="gcount">${g.n}</span><span class="tip">${g.g} · ${g.n}</span></summary>
      <div class="titems">${g.items.map(it => `
        <div class="titem ${it.l2 ? 'l2' : ''} ${it.sel ? 'sel' : ''} ${it.more ? 'more' : ''}">
          ${it.live ? '<span class="live" title="Playing"></span>' : ''}${it.sev ? `<span class="sev-dot" style="background:var(--s${it.sev})"></span>` : ''}
          <span class="tn">${it.n}</span>${it.m ? `<span class="tm">${it.m}</span>` : ''}
          ${it.more ? '' : `<button class="eye ${it.off ? 'off' : ''}" title="${it.off ? 'Show' : 'Hide'}">${I(it.off ? 'eye-off' : 'eye', 's14')}</button>`}
        </div>`).join('')}</div>
    </details>`).join('');
  $$('#tree .eye').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); const off = b.classList.toggle('off');
    b.innerHTML = I(off ? 'eye-off' : 'eye', 's14');
  }));
  const p = PROJECTS.find(x => x.id === pid);
  $('#psName').textContent = p.name;
  $('#psMeta').textContent = `${p.client} · ${p.site.split(',').pop().trim()} · ${p.date}`;
  $('#psGlyph').innerHTML = I(p.glyph);
  $('#navIssues').textContent = pid === 'hcl' ? '12' : '14';
}
$('#projMenu').innerHTML = PROJECTS.map(p => `<button data-proj="${p.id}">${I(p.glyph, 's14')}<span>${p.name}</span><span class="mono">${p.client}</span></button>`).join('');
$('#projSwitch').addEventListener('click', () => {
  if (app.dataset.sb === 'collapsed') { setSidebar('expanded'); }
  const m = $('#projMenu'); const open = m.classList.toggle('open');
  $('#projSwitch').setAttribute('aria-expanded', open);
});
$$('#projMenu button').forEach(b => b.addEventListener('click', () => {
  $('#projMenu').classList.remove('open');
  const p = PROJECTS.find(x => x.id === b.dataset.proj);
  if (p.screen) go(p.screen); else { currentProject = p.id; selectProject(p.id); go(1); }
}));

function setSidebar(state) {
  app.dataset.sb = state;
  try { localStorage.setItem('stratlas.o1.sb', state); } catch (e) {}
  const t = $('#sbToggle');
  t.querySelector('.lbl').textContent = state === 'collapsed' ? 'Expand' : 'Collapse';
  t.querySelector('.tip').innerHTML = `${state === 'collapsed' ? 'Expand' : 'Collapse'} sidebar <span class="kbd">Ctrl B</span>`;
}
try { const s = localStorage.getItem('stratlas.o1.sb'); if (s) setSidebar(s); } catch (e) {}
$('#sbToggle').addEventListener('click', () => setSidebar(app.dataset.sb === 'collapsed' ? 'expanded' : 'collapsed'));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(app.dataset.sb === 'collapsed' ? 'expanded' : 'collapsed'); }
  if (e.altKey && /^[1-4]$/.test(e.key)) go(+e.key);
});

/* ------------------------------------------------------------------ screens */
const CRUMBS = {
  1: ['Synapse Solutions', '<b>Projects</b>'],
  2: ['KIPIC', 'Al-Zour LNG Terminal', '<b>Scene</b>'],
  3: ['KOC', 'HCl Tank 710-D-130335', '<b>Inspection</b>'],
  4: ['Stratlas', '<b>Settings</b>'],
};
const inited = {};
let az = null, hc = null;
function go(n) {
  if (n === 'scene') n = currentProject === 'hcl' ? 3 : 2;
  n = +n;
  app.dataset.screen = n;
  $$('.screen').forEach(s => s.classList.toggle('active', +s.dataset.n === n));
  $$('.review button').forEach(b => b.setAttribute('aria-selected', +b.dataset.go === n));
  $('#caption').textContent = `Option 1: Mission, screen ${n} of 4`;
  $('#crumbs').innerHTML = CRUMBS[n].join('<span class="sep">/</span>');
  const nav = n === 1 ? 'projects' : n === 4 ? 'settings' : 'scene';
  $$('.nav-item[data-nav]').forEach(b => b.toggleAttribute('aria-current', b.dataset.nav === nav) || b.removeAttribute('aria-current'));
  $$('.nav-item[data-nav]').forEach(b => { if (b.dataset.nav === nav) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (n === 2 || n === 3) { currentProject = n === 2 ? 'alzour' : 'hcl'; renderTree(currentProject); }
  if (n === 1 && !inited.home) { inited.home = true; initHome(); }
  if (n === 2 && !inited.az) { inited.az = true; initAlZour(); }
  if (n === 3 && !inited.hc) { inited.hc = true; initHCl(); }
  if (n === 4 && !inited.set) { inited.set = true; initSettings(); }
  az && az.setActive(n === 2);
  hc && hc.setActive(n === 3);
  try { history.replaceState(null, '', '#' + n); } catch (e) {}
}
$$('[data-go]').forEach(b => b.addEventListener('click', e => {
  go(b.dataset.go); if (b.dataset.set) showSet(b.dataset.set);
}));

/* ------------------------------------------------------------------ timeline */
function fmtClock(s) { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; }
function fmtMS(s) { const m = Math.floor(s / 60), x = s - m * 60; return `${m}:${x.toFixed(1).padStart(4, '0')}`; }

function buildTimeline(el, cfg) {
  const span = cfg.t1 - cfg.t0, pct = t => ((t - cfg.t0) / span * 100).toFixed(3) + '%';
  const ticks = [];
  for (let t = Math.ceil(cfg.t0 / cfg.minor) * cfg.minor; t <= cfg.t1; t += cfg.minor) {
    const maj = Math.abs(t / cfg.major - Math.round(t / cfg.major)) < 1e-6;
    ticks.push(`<i class="tk ${maj ? 'maj' : 'min'}" style="left:${pct(t)}"></i>` + (maj ? `<span class="tkl" style="left:${pct(t)}">${cfg.label(t)}</span>` : ''));
  }
  el.innerHTML = `
    <div class="tl-h">
      <div class="transport">
        <button class="tool" title="Previous clip">${I('back')}</button>
        <button class="tool play" data-play title="Play or pause (Space)">${I(cfg.paused ? 'play' : 'pause')}</button>
        <button class="tool" title="Next clip">${I('fwd')}</button>
        <button class="tool" aria-pressed="true" title="Loop">${I('loop')}</button>
      </div>
      <div class="tc" data-tc>00:00:00</div>
      <span class="tag mono rate">1.0×</span>
      ${cfg.headExtra || ''}
      <span class="sp"></span>
      ${cfg.right || ''}
      <div class="seg icons" role="group" aria-label="Zoom"><button aria-pressed="false" title="Zoom out">${I('minus', 's14')}</button><button aria-pressed="false" title="Fit">${I('maximize', 's14')}</button><button aria-pressed="false" title="Zoom in">${I('plus', 's14')}</button></div>
    </div>
    <div class="tl-body">
      <div class="tl-labels"><div class="tl-ruler-l"></div>${cfg.tracks.map(t => `<div class="trk-l">${I(t.ic, 's14')}${t.name}<span class="tm">${t.meta || ''}</span></div>`).join('')}</div>
      <div class="tl-tracks">
        <div class="tl-ruler">${ticks.join('')}</div>
        ${cfg.tracks.map(t => `<div class="trk">${t.html(pct)}</div>`).join('')}
        <div class="playhead" data-ph></div>
      </div>
    </div>`;
  const ph = el.querySelector('[data-ph]'), tc = el.querySelector('[data-tc]');
  return {
    set(t, label) { ph.style.left = pct(t); tc.innerHTML = label; },
    onPlay(fn) { const b = el.querySelector('[data-play]'); b.addEventListener('click', () => { const playing = fn(); b.innerHTML = I(playing ? 'pause' : 'play'); }); },
  };
}

/* ------------------------------------------------------------------ HOME */
function selectProject(id) {
  $$('.prow').forEach(r => r.classList.toggle('sel', r.dataset.id === id));
  $$('.pm').forEach(m => m.classList.toggle('sel', m.dataset.id === id));
}
function initHome() {
  const offLbl = { ready: 'Offline ready', partial: 'Photos 71% local', sync: 'Syncing 62%' };
  $('#libList').innerHTML = PROJECTS.map(p => `
    <div class="prow ${p.id === 'alzour' ? 'sel' : ''}" data-id="${p.id}" tabindex="0">
      <div class="pg">${I(p.glyph, 's20')}</div>
      <div class="pn">${p.name}</div><div class="pd">${p.date}</div>
      <div class="ps">${p.client} · ${p.type} · ${p.site}</div><div class="psz">${p.size}</div>
      <div class="players">${p.layers.map(([ic, v]) => `<span class="lchip">${I(ic)}${v}</span>`).join('')}
        <span class="off ${p.off}"><span class="od"></span>${offLbl[p.off]}</span></div>
    </div>`).join('');
  $$('.prow').forEach(r => {
    r.addEventListener('click', () => selectProject(r.dataset.id));
    r.addEventListener('dblclick', () => { const p = PROJECTS.find(x => x.id === r.dataset.id); if (p.screen) go(p.screen); });
  });
  $('#activity').innerHTML = [
    ['09:42', '<b>Agent</b> drafted 6 roof-visible ranges on <b>20-T-0002</b>, Al-Zour'],
    ['09:18', '<b>F12</b> drafted on HCl Tank, roof nozzle, severity 4'],
    ['Thu', '<b>Report v3</b> exported, EBSM Flare Stack, 84 pages'],
    ['Wed', '<b>GCC streets</b> pack updated to 2026-09'],
  ].map(([t, s]) => `<div class="act"><span class="mono">${t}</span><span>${s}</span></div>`).join('');
  import(`./option-1-mission-map.js?v=r2`).then(m => m.drawHomeMap($('#basemap'), PROJECTS, id => selectProject(id), id => { const p = PROJECTS.find(x => x.id === id); if (p.screen) go(p.screen); }))
    .catch(err => console.error(err));
}

/* ------------------------------------------------------------------ AL-ZOUR */
function initAlZour() {
  $('#azCtx').innerHTML = `
    <div class="panel-h"><h3>Selection</h3><span class="sub">Asset · plant model node</span><div class="acts"><button class="btn icon sm ghost" title="Fly to">${I('target', 's14')}</button><button class="btn icon sm ghost" title="More">${I('more', 's14')}</button></div></div>
    <div class="ctx-body">
      <div class="ent-h"><div class="ent-ic">${I('tank', 's20')}</div><div class="et"><b>20-T-0002</b><span>LNG storage tank · Area 20, LNG tanks</span></div></div>
      <div class="mini-stats">
        <div><div class="v">4<span class="faint">/25</span></div><div class="k">Clips over</div></div>
        <div><div class="v">312</div><div class="k">Roof frames</div></div>
        <div><div class="v" style="display:flex;gap:4px;align-items:center">3 <span class="sevbar" style="width:34px;margin:0"><i style="flex:1;background:var(--s4)"></i><i style="flex:2;background:var(--s3)"></i></span></div><div class="k">Open issues</div></div>
      </div>
      <dl class="kv" style="margin:0">
        <dt>Plant grid</dt><dd class="mono">E 1446.0  N 555.4</dd>
        <dt>UTM 39N</dt><dd class="mono">E 245 884.9  N 3 179 597.1</dd>
        <dt>Geometry</dt><dd>Wall Ø 93.5 m · dome EL 151.5 m</dd>
        <dt>Last capture</dt><dd>21 Feb 2023 · Mavic 3 Cine</dd>
      </dl>
    </div>`;

  $('#azAgent').innerHTML = `
    <div class="panel-h"><h3 style="display:flex;align-items:center;gap:6px">${I('agent', 's14')}Agent</h3><span class="agent-bind">${I('scene', 's12')}3D view</span><div class="acts"><button class="btn icon sm ghost" title="History">${I('history', 's14')}</button><button class="btn icon sm ghost" title="Close">${I('x', 's14')}</button></div></div>
    <div class="agent-log">
      <div class="msg user">Show me every clip that passes over tank 20-T-0002 and the frames where the roof is visible.
        <div class="ctxline"><span class="tag">${I('scene', 's12')}3D view</span><span class="tag">20-T-0002</span><span class="tag">25 clips</span></div></div>
      <div class="msg">
        <div class="who">${I('agent', 's12')}<b>Claude Sonnet 4.5</b><span>· Anthropic · 6.2 s</span></div>
        <div class="steps">
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>query_flight_paths</code><span class="sr">4 of 25 clips</span></div>
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>compute_roof_visibility</code><span class="sr">312 frames</span></div>
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>filter_timeline</code><button class="btn sm ghost">${I('undo', 's12')}Undo</button></div>
          <div class="step wait"><span class="si">${I('clock', 's14')}</span><code>add_bookmarks ×6</code><span class="sr">needs approval</span></div>
          <div class="approve"><span class="note">Writes 6 bookmarks to the project</span><button class="btn sm">Reject</button><button class="btn sm primary" id="azApprove">${I('check', 's12')}Approve</button></div>
        </div>
        Four clips cross 20-T-0002 within a 40 m buffer. The roof is in frame, at least 30% visible, in <b class="hi">312 frames</b> across six ranges. Best coverage is DJI_0789, approaching from the west at 104 m.
        <div class="result-list">
          ${[['DJI_0789', '15:11 · 0:05 to 0:16', 94, true], ['DJI_0781', '14:52 · 1:02 to 1:31', 71], ['DJI_0772', '14:31 · 0:12 to 0:26', 48], ['DJI_0702', '13:48 · 3:40 to 3:52', 36]]
            .map(([c, r, v, on]) => `<div class="rl">${I('video', 's14')}<span><b>${c}</b> <span class="mono">${r}</span></span><span style="display:flex;align-items:center;gap:6px"><span class="bar cov"><i style="width:${v}%;${on ? '' : 'opacity:.55'}"></i></span><span class="mono">${v}%</span></span></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="agent-in">
      <div class="box">
        <textarea placeholder="Ask about this view, or tell the agent what to do" aria-label="Message the agent"></textarea>
        <div class="row"><span class="tag">${I('scene', 's12')}3D view</span><span class="tag">20-T-0002</span><span class="tag mono" id="azCtxT">15:11:16</span><span class="sp"></span><button class="btn icon sm ghost" title="Attach frame">${I('camera', 's14')}</button><button class="btn icon sm primary" title="Send">${I('send', 's14')}</button></div>
      </div>
      <div class="row"><span>Claude Sonnet 4.5 · cloud</span><span class="sp"></span><span class="mono">12.4k tok · $0.04</span></div>
    </div>`;
  $('#azApprove').addEventListener('click', e => {
    const step = $('#azAgent .step.wait');
    step.className = 'step done'; step.querySelector('.si').innerHTML = I('check', 's14');
    step.querySelector('.sr').textContent = '6 added';
    e.target.closest('.approve').innerHTML = `<span class="note undo-chip">${I('check', 's12')}Approved by DR · 6 bookmarks</span><button class="btn sm ghost">${I('undo', 's12')}Undo</button>`;
    $$('#azTL .rng').forEach(r => r.classList.remove('pending'));
  });

  // timeline: survey day 21 Feb 2023, 12:30 to 15:30
  const T0 = 12.5 * 3600, T1 = 15.5 * 3600;
  const clipStarts = [12*3600+41*60, 12*3600+47*60, 12*3600+53*60, 12*3600+58*60, 13*3600+4*60, 13*3600+10*60, 13*3600+17*60, 13*3600+32*60+33, 13*3600+40*60, 13*3600+48*60, 13*3600+55*60, 14*3600+2*60, 14*3600+9*60, 14*3600+16*60, 14*3600+24*60, 14*3600+31*60, 14*3600+38*60, 14*3600+45*60, 14*3600+52*60, 14*3600+58*60, 15*3600+4*60, 15*3600+11*60+11, 15*3600+17*60, 15*3600+22*60, 15*3600+26*60];
  const names = ['0601','0607','0612','0618','0623','0630','0641','0665','0688','0702','0715','0726','0737','0748','0759','0772','0776','0779','0781','0783','0785','0789','0794','0798','0801'];
  const hits = new Set(['0702', '0772', '0781', '0789']);
  const dur = [150,140,170,120,160,130,150,112,140,250,130,150,160,140,120,170,150,130,170,120,140,112,140,120,90];
  const clipsHtml = pct => names.map((n, i) => `<div class="seg-c ${n === '0789' ? 'on' : hits.has(n) ? 'hit' : 'dim'}" style="left:${pct(clipStarts[i])};width:calc(${(dur[i] / (T1 - T0) * 100).toFixed(3)}% - 1px)" title="DJI_${n}"></div>${n === '0789' ? `<span class="seg-lbl" style="left:calc(${pct(clipStarts[i] + dur[i])} + 4px)">DJI_0789</span>` : ''}`).join('');
  const roof = [[0, 5, 16], [9, 40, 52], [15, 12, 26], [18, 62, 91], [18, 110, 128], [21, 5, 16]]; // [clip, start, end] s
  const roofHtml = pct => roof.map(([ci, a, b]) => `<i class="rng pending" style="left:${pct(clipStarts[ci] + a)};width:max(4px, ${((b - a) / (T1 - T0) * 100).toFixed(3)}%)"></i>`).join('');
  const altPts = []; for (let i = 0; i <= 120; i++) { const t = i / 120; const v = 0.55 + 0.25 * Math.sin(t * 19) * Math.sin(t * 5.3) + 0.12 * Math.sin(t * 61); altPts.push(`${(t * 100).toFixed(2)},${(16 - v * 14).toFixed(2)}`); }
  const panos = [[13*3600+15*60+20, '0655'], [15*3600+7*60+7, '0787'], [15*3600+12*60+43, '0790'], [12*3600+44*60], [13*3600+1*60], [13*3600+44*60], [13*3600+58*60], [14*3600+12*60], [14*3600+27*60], [14*3600+41*60], [14*3600+55*60], [15*3600+19*60]];
  const tl = buildTimeline($('#azTL'), {
    t0: T0, t1: T1, minor: 300, major: 1800, label: t => fmtClock(t).slice(0, 5),
    headExtra: `<span class="tag">${I('filter', 's12')}Filtered by agent: 4 clips</span>`,
    right: `<span class="faint" style="font-size:11px">21 Feb 2023 · local time</span>`,
    tracks: [
      { name: 'Clips', ic: 'video', meta: '25', html: clipsHtml },
      { name: 'Altitude', ic: 'drone', meta: 'm', html: () => `<svg class="alt" viewBox="0 0 100 18" preserveAspectRatio="none" style="width:100%;height:20px"><polyline points="${altPts.join(' ')}" fill="none" stroke="oklch(0.80 0.01 250 / .55)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>` },
      { name: 'Roof visible', ic: 'eye', meta: 'draft', html: roofHtml },
      { name: 'Panoramas', ic: 'pano', meta: '12', html: pct => panos.map(([t]) => `<i class="tick" style="left:${pct(t)}"></i>`).join('') },
      { name: 'Issues', ic: 'issues', meta: '14', html: pct => [[13*3600+50*60, 4], [14*3600+33*60, 3], [15*3600+11*60+20, 4], [15*3600+12*60, 3], [14*3600+53*60, 3], [13*3600+6*60, 2]].map(([t, s]) => `<i class="dia" style="left:${pct(t)};background:var(--s${s})"></i>`).join('') },
    ],
  });
  const startT = 15 * 3600 + 11 * 60 + 11 + 5;
  import(`./option-1-mission-3d.js?v=r2`).then(m => {
    az = m.initAlZour({
      canvas: $('#azCanvas'), ovl: $('#azOvl'), stage: $('#azStage'), vframe: $('#azVframe'), compass: $('#azCompass'),
      loading: $('#azLoading'), assets: A + 'alzour/',
      onTime(ct, s) {
        const t = startT + ct;
        tl.set(t, `${fmtClock(t)}<small>.${String(Math.floor((ct % 1) * 30)).padStart(2, '0')}</small>`);
        $('#azHudBL').textContent = `${fmtClock(t)}:${String(Math.floor((ct % 1) * 30)).padStart(2, '0')}`;
        $('#azCtxT').textContent = fmtClock(t);
        if (s) {
          $('#azHudTR').innerHTML = `ALT ${s.alt.toFixed(1)} m<br>GBL ${s.pitch.toFixed(1)}°`;
          $('#azHudBR').textContent = `HDG ${s.az.toFixed(0).padStart(3, '0')}°`;
        }
      },
      onScale(m, px) { $('#azScaleLbl').textContent = `${m} m`; $('#azScale').style.width = px + 'px'; },
      onCursor(txt) { $('#azCursor').innerHTML = txt; },
    });
    az.setActive(+app.dataset.screen === 2);
    tl.onPlay(() => az.togglePlay());
  }).catch(err => { console.error(err); $('#azLoading').textContent = 'Scene failed to load'; });
}

/* ------------------------------------------------------------------ HCL */
let hcSel = 'F12';
function renderHclRight() {
  const counts = [5, 4, 3].map(s => HCL_ISSUES.filter(i => i.sev === s).length);
  const sel = HCL_ISSUES.find(i => i.id === hcSel);
  const sightings = sel.id === 'F12'
    ? [['video', 'Video 110 · 0:56.4', `${A}hcl/clip_f110_external_poster.jpg`, 'box'], ['scene', 'Mesh · roof', null, 'mesh'], ['photo', 'F04 · 101_0035', `${A}hcl/photos/F04_101_0035.jpg`, 'near F04']]
    : [['photo', `Photo ${sel.photo ? sel.photo.slice(4, 12) : 'none'}`, sel.photo ? `${A}hcl/photos/${sel.photo}` : null], ['scene', 'Mesh pin', null], ['cloud', 'Point cloud', null]];
  $('#hcRight').innerHTML = `
    <div class="panel-h"><h3>Issues</h3><span class="sub mono">12</span><div class="acts"><button class="btn icon sm ghost" title="Filter">${I('filter', 's14')}</button><button class="btn icon sm ghost" title="Export CSV, GeoJSON, COCO">${I('download', 's14')}</button></div></div>
    <div class="issue-filter">
      <div class="seg" role="group" aria-label="Severity filter"><button aria-pressed="true">All</button><button aria-pressed="false"><span class="sev-dot" style="background:var(--s5)"></span>${counts[0]}</button><button aria-pressed="false"><span class="sev-dot" style="background:var(--s4)"></span>${counts[1]}</button><button aria-pressed="false"><span class="sev-dot" style="background:var(--s3)"></span>${counts[2]}</button></div>
      <span class="faint" style="font-size:11px;margin-left:auto">Tank, rubber lining · 1 to 5</span>
    </div>
    <div class="issues">${HCL_ISSUES.map(i => `
      <div class="irow ${i.id === hcSel ? 'sel' : ''} ${i.draft ? 'draft' : ''}" data-id="${i.id}">
        <span class="iid">${i.id}</span><span class="it">${i.t}</span><span class="sev s${i.sev}"><i></i>${i.sev}</span>
        <span class="im">${i.area} · el. ${i.el} m · ${i.brg}° · <span class="st">${i.st}</span></span>
      </div>`).join('')}</div>
    <section style="border-top:1px solid var(--line);flex:none">
      <div class="panel-h"><h3>${sel.id} · ${sel.t}</h3><div class="acts"><button class="btn icon sm ghost" title="Fly to">${I('target', 's14')}</button></div></div>
      <div class="ctx-body" style="gap:10px">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="sev s${sel.sev}"><i></i>${sel.sev} ${SEV_MODEL.find(s => s.l === sel.sev).name}</span><span class="tag">${sel.cls}</span><span class="tag ${sel.draft ? 'acc' : ''}">${sel.st}</span>${sel.draft ? '<span class="faint" style="font-size:11px;margin-left:auto">by DR · 09:18</span>' : ''}</div>
        <div class="sightings">${sightings.map(([ic, l, img, kind]) => `
          <div class="sighting"><div class="sth" ${img ? `style="background-image:url('${img}')"` : ''}>${!img ? `<svg viewBox="0 0 40 30" style="position:absolute;inset:0;width:100%;height:100%"><g fill="none" stroke="oklch(0.6 0.012 250)" stroke-width=".6"><ellipse cx="20" cy="8" rx="9" ry="2.6"/><path d="M11 8v16c0 1.4 4 2.6 9 2.6s9-1.2 9-2.6V8"/></g><circle cx="${ic === 'cloud' ? 24 : 23}" cy="${sel.id === 'F12' || +sel.el > 7 ? 8.5 : 14 + (8 - +sel.el)}" r="1.8" fill="var(--s${sel.sev})"/></svg>` : ''}${kind === 'box' ? '<i style="position:absolute;left:58%;top:28%;width:16%;height:22%;border:1.5px solid var(--s4)"></i>' : ''}</div><div class="stl">${I(ic, 's12')}${l}</div></div>`).join('')}</div>
        ${sel.draft ? `<div class="faint" style="font-size:11px;line-height:1.5">Back-projected from the video frame with the f-theta pose at 0:56.4. Nearest existing issue: F04 at 0.47 m, inside the roof.</div>` : ''}
      </div>
    </section>`;
  $$('#hcRight .irow').forEach(r => r.addEventListener('click', () => { hcSel = r.dataset.id; renderHclRight(); hc && hc.focusIssue(hcSel); }));
}

function initHCl() {
  renderHclRight();
  $('#hcAgent').innerHTML = `
    <div class="panel-h"><h3 style="display:flex;align-items:center;gap:6px">${I('agent', 's14')}Agent</h3><span class="agent-bind">${I('video', 's12')}Video window · frame 0:56.4</span><div class="acts"><button class="btn icon sm ghost" title="Close">${I('x', 's14')}</button></div></div>
    <div class="agent-log" style="padding:10px 12px;gap:10px">
      <div class="msg user">Track this box through the clip, place it on the mesh, and check whether it is F04 seen from outside.</div>
      <div class="msg">
        <div class="who">${I('agent', 's12')}<b>Gemini 2.5 Pro</b><span>· video understanding · 4.8 s</span></div>
        <div class="steps">
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>track_box F12</code><span class="sr">0:52.1 to 0:58.9 · 204 fr</span></div>
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>backproject_to_mesh</code><span class="sr">roof · el. 8.79 m</span></div>
          <div class="step done"><span class="si">${I('check', 's14')}</span><code>match_issues</code><span class="sr">F04 · 0.47 m</span></div>
          <div class="step wait"><span class="si">${I('clock', 's14')}</span><code>link F12 to F04</code><span class="sr">needs approval</span></div>
          <div class="approve"><span class="note">Adds a cross-reference to both issues</span><button class="btn sm">Reject</button><button class="btn sm primary">${I('check', 's12')}Approve</button></div>
        </div>
        F12 sits 0.47 m from F04, on the outer face of the same roof plate. The blisters inside and the coating breakdown outside are likely one failure through the plate, so I would keep two issues and link them.
      </div>
    </div>
    <div class="agent-in" style="padding-top:6px">
      <div class="box" style="padding:6px 8px 6px 10px"><textarea style="height:20px" placeholder="Ask about this frame" aria-label="Message the agent"></textarea>
      <div class="row"><span class="tag">${I('video', 's12')}Video 110</span><span class="tag">F12 box</span><span class="sp"></span><span class="mono">8.1k tok</span><button class="btn icon sm primary" title="Send">${I('send', 's14')}</button></div></div>
    </div>`;

  $('#hcAgent .agent-log').scrollTop = 1e6;
  const FLIGHTS = { f110: { len: 180, start: 50, name: 'Flight 110, external', meta: '110_0262.MOV · Elios 3', issues: [[56.4, 4, 'F12'], [58.0, 4, 'F02 ext.']] },
                    f108: { len: 300, start: 225, name: 'Flight 108, roof', meta: '108_0217.MOV · Elios 3', issues: [[105.1, 3, 'F05'], [229.5, 5, 'F01']] } };
  let tl, clip = 'f110';
  const buildTL = () => {
    const f = FLIGHTS[clip];
    tl = buildTimeline($('#hcTL'), {
      t0: 0, t1: f.len, minor: 5, major: 30, paused: true, label: t => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`,
      headExtra: `<div class="seg" role="group" aria-label="Flight">${[101,102,103,104,105,106,107,108,109,110].map(n => `<button aria-pressed="${'f' + n === clip}" class="mono" style="padding:0 6px;font-size:11px">${n}</button>`).join('')}</div>`,
      right: `<span class="faint" style="font-size:11px">22 Nov 2023 · flight time</span>`,
      tracks: [
        { name: 'Flight video', ic: 'video', meta: fmtMS(f.len).slice(0, -2), html: pct => `<div class="seg-c dim" style="left:0;width:100%;opacity:.6">${f.meta.split(' ')[0]}</div><div class="seg-c on" style="left:${pct(f.start)};width:${(11 / f.len * 100).toFixed(2)}%">clip</div>` },
        { name: 'Pose log', ic: 'drone', meta: '10 Hz', html: pct => `<div class="seg-c dim" style="left:0;width:100%;background:repeating-linear-gradient(90deg,var(--line) 0 1px,transparent 1px 4px);border-color:var(--line-soft)"></div><div class="seg-c hit" style="left:${pct(f.start)};width:${(11 / f.len * 100).toFixed(2)}%"></div>` },
        { name: 'Issues', ic: 'issues', meta: String(f.issues.length), html: pct => f.issues.map(([t, s, l]) => `<i class="dia" style="left:${pct(t)};background:var(--s${s})" title="${l}"></i>`).join('') },
        { name: 'Frames', ic: 'photo', meta: 'every 2 s', html: pct => Array.from({ length: Math.floor(f.len / 2) }, (_, i) => `<i class="tick" style="left:${pct(i * 2)};height:6px;top:10px;opacity:.6"></i>`).join('') },
      ],
    });
    tl.onPlay(() => hc ? hc.togglePlay() : true);
  };
  buildTL();
  $$('[data-clip]').forEach(b => b.addEventListener('click', () => {
    clip = b.dataset.clip; $$('[data-clip]').forEach(x => x.setAttribute('aria-pressed', x === b));
    $('#hcClipName').textContent = FLIGHTS[clip].name; $('#hcClipMeta').textContent = FLIGHTS[clip].meta;
    $('#hcDraw').style.display = clip === 'f110' ? '' : 'none';
    buildTL(); hc && hc.setClip(clip);
  }));

  import(`./option-1-mission-3d.js?v=r2`).then(m => {
    hc = m.initHCl({
      canvas: $('#hcCanvas'), ovl: $('#hcOvl'), stage: $('#hcStage'), vframe: $('#hcVframe'), compass: $('#hcCompass'),
      loading: $('#hcLoading'), assets: A + 'hcl/', issues: HCL_ISSUES, draw: $('#hcDraw'), strip: $('#hcStrip'),
      onTime(ct, s) {
        const f = FLIGHTS[clip], t = f.start + ct;
        const fr = String(Math.floor((ct % 1) * 30)).padStart(2, '0');
        tl.set(t, `00:${fmtClock(t).slice(3)}<small>.${fr}</small>`);
        $('#hcHudBL').textContent = `00:${fmtClock(t).slice(3)}:${fr}`;
        if (s) $('#hcHudTR').innerHTML = `Z ${s.pos[1].toFixed(2)} m<br>TILT ${s.servo_deg.toFixed(1)}°`;
      },
    });
    hc.setActive(+app.dataset.screen === 3);
  }).catch(err => { console.error(err); $('#hcLoading').textContent = 'Scene failed to load'; });
}

/* ------------------------------------------------------------------ SETTINGS */
function initSettings() {
  const prov = (logo, name, state, key, note, models) => `
    <div class="prov">
      <div class="plogo">${logo}</div>
      <div><div class="pn">${name}${state ? '<span class="state ok"><i></i>Connected</span>' : '<span class="state no"><i></i>Not set up</span>'}</div>
      <div class="pk">${note}</div></div>
      <div style="display:flex;gap:4px">${state ? `<button class="btn sm">Test</button><button class="btn sm ghost">Remove</button>` : ''}</div>
      <div class="key">${I('key', 's14 faint')}${state
        ? `<input class="input" value="${key}" readonly aria-label="${name} API key, masked"><button class="btn sm ghost" title="Replace key">Replace</button>`
        : `<input class="input" placeholder="Paste a Gemini API key" aria-label="Gemini API key" style="font-family:var(--f-ui)"><button class="btn sm primary">Save to vault</button>`}</div>
      ${models ? `<div class="pk" style="grid-column:2/4;margin-top:2px">${models}</div>` : ''}
    </div>`;
  const route = (task, ic, provider, model, data, extra = '') => `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;color:var(--fg-0)">${I(ic, 's14 faint')}${task}${extra}</div></td>
      <td><select class="input" aria-label="Provider for ${task}"><option ${provider === 'Anthropic' ? 'selected' : ''}>Anthropic</option><option ${provider === 'OpenAI' ? 'selected' : ''}>OpenAI</option><option ${provider === 'Google' ? 'selected' : ''}>Google</option><option>Local (later)</option></select></td>
      <td><select class="input mono" aria-label="Model for ${task}"><option>${model}</option></select></td>
      <td class="faint" style="white-space:nowrap">${data}</td></tr>`;
  const aw = (ic, n, on, m) => `<div><div class="aw-h">${I(ic, 's14 faint')}${n}<button class="switch" role="switch" aria-checked="${on}" aria-label="Agent in ${n}"></button></div><div class="aw-m">${m}</div></div>`;
  const opt = (b, s, on, lock) => `<div class="opt"><b>${b}${lock ? ` <span class="faint" title="Always on">${I('lock', 's12')}</span>` : ''}</b><span>${s}</span><button class="switch" role="switch" aria-checked="${on}" ${lock ? 'disabled style="opacity:.6"' : ''} aria-label="${b}"></button></div>`;

  const ai = `
    <section class="set-page on" data-page="ai">
      <header><div><h1>AI and agents</h1><p>Keys stay in the Windows Credential Manager and never enter project files or logs. Every agent action is a step you can approve or undo.</p></div>
        <div class="acts"><button class="btn">${I('history', 's14')}Audit log</button></div></header>
      <div class="set-grid">
        <div>
          <div class="sblock"><h2>Providers <span class="sub">3 supported</span></h2>
            ${prov('A', 'Anthropic', true, 'sk-ant-api03-••••••••••••••••••••7f3Q', 'Added 2 Sep 2026 by DR · last used 09:42', 'Claude Opus 4.1 · Claude Sonnet 4.5 · Claude Haiku 4.5')}
            ${prov('O', 'OpenAI', true, 'sk-proj-••••••••••••••••••••••a91C', 'Added 2 Sep 2026 by DR · last used yesterday', 'GPT-5 · GPT-5 mini')}
            ${prov('G', 'Google Gemini', false, '', 'Needed for the video-understanding route below')}
          </div>
          <div class="sblock"><h2>Model routing <span class="sub">per task</span><span class="acts"><button class="btn sm ghost">Reset to defaults</button></span></h2>
            <table class="tbl"><thead><tr><th style="width:34%">Task</th><th>Provider</th><th>Model</th><th>Sends</th></tr></thead><tbody>
              ${route('Agent chat', 'agent', 'Anthropic', 'claude-sonnet-4-5', 'Text, view context')}
              ${route('Photo and frame vision', 'photo', 'OpenAI', 'gpt-5', 'Frames, crops')}
              ${route('Video understanding', 'video', 'Google', 'gemini-2.5-pro', 'Clips up to 60 s', ` <span title="Key missing" style="color:var(--s3)">${I('warn', 's12')}</span>`)}
              ${route('Report writing', 'report', 'Anthropic', 'claude-opus-4-1', 'Issue text')}
              ${route('Structured extraction', 'raster', 'OpenAI', 'gpt-5-mini', 'Text, tables')}
              <tr><td><div style="display:flex;align-items:center;gap:8px;color:var(--fg-2)">${I('cube-roadmap', 's14 faint')}Build 3D from drawings and clouds</div></td><td colspan="3"><span class="soon">ROADMAP · Release B</span></td></tr>
            </tbody></table>
          </div>
          <div class="sblock"><h2>Agent in every window <span class="sub">each agent sees only its window's context</span></h2>
            <div class="awin">
              ${aw('scene', '3D view', true, 'Fly to, select, measure, section')}
              ${aw('map', 'Map', true, 'Filter, draw, compare dates')}
              ${aw('cloud', 'Point cloud', true, 'Box select, classify, measure')}
              ${aw('video', 'Video', true, 'Set time, track, capture frame')}
              ${aw('photo', 'Photo', true, 'Detect, draft annotations')}
              ${aw('issues', 'Issues', true, 'Filter, merge, draft notes')}
              ${aw('report', 'Report', true, 'Draft sections, check figures')}
              ${aw('clock', 'Timeline', false, 'Bookmarks, ranges')}
            </div>
          </div>
        </div>
        <div>
          <div class="sblock">
            <div class="master"><b>Offline only</b><button class="switch" role="switch" aria-checked="false" aria-label="Offline only"></button>
              <p>Off: cloud AI is allowed where each project's policy permits. Default is on. Changed 2 Sep 2026 by DR.</p></div>
          </div>
          <div class="sblock" id="privacy"><h2>Project data policy</h2>
            <table class="tbl"><thead><tr><th>Project</th><th>May send</th></tr></thead><tbody>
              ${[['Al-Zour LNG Terminal', 'Text and frames'], ['HCl Tank 710-D-130335', 'Text and frames'], ['EBSM Flare Stack', 'Text only'], ['DAMAC Hills Tower Facade', 'Nothing'], ['Masafi Stockpile Yard', 'Text only'], ['1st Ring Road Survey', 'Text and frames']]
                .map(([p, v]) => `<tr><td style="color:var(--fg-0)">${p}</td><td style="width:150px"><select class="input" aria-label="Policy for ${p}">${['Text and frames', 'Text only', 'Nothing'].map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></td></tr>`).join('')}
            </tbody></table>
          </div>
          <div class="sblock"><h2>Approvals</h2>
            ${opt('Ask before data-sending actions', 'Frames, photos and clips', true, true)}
            ${opt('Ask before destructive actions', 'Delete, merge, overwrite', true, true)}
            ${opt('Preview payload on first send', 'Per project, per provider', true)}
            ${opt('Keep conversations with the project', 'Exportable with the project', true)}
          </div>
          <div class="sblock"><h2>Usage <span class="sub">October</span></h2>
            <div class="meter"><span>Anthropic <span class="faint mono">3.1 M tok</span></span><span class="mono hi">$41.20</span><div class="bar"><i style="width:62%"></i></div></div>
            <div class="meter" style="margin-top:10px"><span>OpenAI <span class="faint mono">0.9 M tok</span></span><span class="mono hi">$6.80</span><div class="bar"><i style="width:14%"></i></div></div>
            <div class="meter" style="margin-top:10px"><span>Google <span class="faint mono">0 tok</span></span><span class="mono">$0.00</span><div class="bar"><i style="width:0"></i></div></div>
          </div>
        </div>
      </div>
    </section>`;

  const packs = [
    ['KW', 'Kuwait', 'Streets to z16 · Arabic, English', '612 MB', '2026-09', 'ok'],
    ['AE', 'United Arab Emirates', 'Streets to z16', '1.92 GB', '2026-06', 'upd'],
    ['SA', 'Saudi Arabia', 'Streets to z15 · main roads z16', '3.41 GB', '2026-09', 'ok'],
    ['QA', 'Qatar', 'Streets to z16', '288 MB', '2026-09', 'ok'],
    ['BH', 'Bahrain', 'Streets to z16', '96 MB', '2026-09', 'ok'],
    ['OM', 'Oman', 'Streets to z15', '1.07 GB', '2026-09', 'dl'],
    ['WW', 'World overview', 'Coastlines, borders, cities, z0 to z8', '1.10 GB', '2026-06', 'ok'],
  ];
  const stLbl = { ok: '<span class="state ok"><i></i>Installed</span>', upd: '<span class="state" style="color:var(--s3)"><i style="background:var(--s3)"></i>Update, 214 MB</span>', dl: '<span style="display:flex;align-items:center;gap:8px;font-size:11px" class="mono"><span class="bar" style="width:70px"><i style="width:64%"></i></span>64%</span>' };
  const maps = `
    <section class="set-page" data-page="maps">
      <header><div><h1>Offline maps</h1><p>OpenStreetMap vector packs render with no network. GCC to street level, the world to overview zoom. Packs are shared by every project on this workstation.</p></div>
        <div class="acts"><button class="btn">${I('import', 's14')}Import pack file</button><button class="btn primary">${I('plus', 's14')}Add region</button></div></header>
      <div class="set-grid">
        <div class="packs">
          <div class="sblock"><h2>Installed packs <span class="sub">7 packs · 8.49 GB</span><span class="acts"><button class="btn sm">${I('refresh', 's12')}Check for updates</button></span></h2>
            <table class="tbl"><thead><tr><th>Region</th><th>Size</th><th>Data</th><th>Status</th><th></th></tr></thead><tbody>
            ${packs.map(([cc, n, d, sz, dt, st]) => `<tr><td><div class="pk-name"><span class="flag">${cc === 'WW' ? I('globe', 's14') : cc}</span><div><b>${n}</b><span>${d}</span></div></div></td><td class="mono">${sz}</td><td class="mono">${dt}</td><td>${stLbl[st]}</td><td style="text-align:right">${st === 'upd' ? `<button class="btn sm">${I('download', 's12')}Update</button>` : st === 'dl' ? `<button class="btn sm ghost">Pause</button>` : `<button class="btn icon sm ghost" title="More">${I('more', 's14')}</button>`}</td></tr>`).join('')}
            <tr><td><div class="pk-name"><span class="flag" style="border-style:dashed">${I('raster', 's14')}</span><div><b style="color:var(--fg-2)">Satellite imagery</b><span>Only sources whose licence allows offline use</span></div></div></td><td class="faint">none</td><td></td><td colspan="2"><span class="soon">NOT AVAILABLE</span></td></tr>
            </tbody></table>
          </div>
          <div class="sblock"><h2>Style</h2>
            ${opt('Dark map style', 'Matches the app theme; light style follows the light theme', true)}
            ${opt('Arabic and English labels', 'Show both where OSM has both names', true)}
            ${opt('Use as ground plane in 3D scenes', 'Under project orthomosaics', true)}
          </div>
        </div>
        <div>
          <div class="sblock"><h2>Coverage</h2>
            <div class="coverage"><svg id="covMap" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice"></svg></div>
            <div class="legend-row" style="margin-top:8px"><span><i style="background:oklch(0.79 0.115 172 / .5)"></i>Installed</span><span><i style="background:oklch(0.84 0.14 92 / .45)"></i>Update available</span><span><i style="background:oklch(0.74 0.08 235 / .45)"></i>Downloading</span></div>
          </div>
          <div class="storage">
            <div style="display:flex;justify-content:space-between;font-size:12px"><span class="hi">Map storage</span><span class="mono">8.49 of 40 GB</span></div>
            <div class="stack"><i style="flex:3.41;background:var(--acc)"></i><i style="flex:1.92;background:var(--s3)"></i><i style="flex:1.1;background:oklch(0.65 0.06 172)"></i><i style="flex:2.06;background:oklch(0.55 0.05 172)"></i><i style="flex:31.5;background:var(--bg-3)"></i></div>
            <div class="legend-row"><span><i style="background:var(--acc)"></i>Saudi Arabia</span><span><i style="background:var(--s3)"></i>UAE</span><span><i style="background:oklch(0.65 0.06 172)"></i>World</span><span><i style="background:oklch(0.55 0.05 172)"></i>Others</span></div>
            <div class="faint" style="font-size:11px">Location: D:\\Stratlas\\maps · change in Storage and cache</div>
          </div>
        </div>
      </div>
    </section>`;

  const models = [['Tank, rubber lining', 'Client scale 1 to 5 · HCl Tank', [1,1,1,1,1], true], ['Flare and stack', 'Asset Inspection Kit · EBSM', [1,1,1,1]], ['Telecom tower', 'Asset Inspection Kit', [1,1,1,1]], ['OHTL tower', 'Asset Inspection Kit', [1,1,1,1]], ['Building facade', 'Kit profile · DAMAC Hills', [1,1,1,1,1]], ['Road distress', 'ASTM D6433 low, medium, high', [1,1,1]], ['Stockpile', 'Volume change bands', [1,1,1]]];
  const sevCols = ['var(--s5)', 'var(--s4)', 'var(--s3)', 'var(--s2)', 'var(--s1)'];
  const sev = `
    <section class="set-page" data-page="sev">
      <header><div><h1>Severity models</h1><p>Each project grades issues with one model. Levels carry a colour, criteria and a recommended action; the issue register, the 3D pins and the PDF report all read from here.</p></div>
        <div class="acts"><button class="btn">${I('import', 's14')}Import kit profile</button><button class="btn primary">${I('plus', 's14')}New model</button></div></header>
      <div class="sev-ed">
        <div class="models-list">
          <div class="caps faint" style="padding:0 10px 6px">Templates and project models</div>
          ${models.map(([n, s, lv, on]) => `<button aria-current="${!!on}"><b>${n}</b><span>${s}</span><span class="sevbar">${lv.map((_, i) => `<i style="flex:1;background:${lv.length === 3 ? ['var(--s5)', 'var(--s3)', 'var(--s2)'][i] : sevCols[i]}"></i>`).join('')}</span></button>`).join('')}
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div><div style="font-size:var(--t-16);color:var(--fg-0);font-weight:600">Tank, rubber lining</div><div class="faint" style="font-size:12px">Used by HCl Tank 710-D-130335 · 12 issues graded · edited 22 Nov 2023</div></div>
            <div style="margin-left:auto;display:flex;gap:6px"><button class="btn">${I('copy', 's14')}Duplicate</button><button class="btn">Save</button></div>
          </div>
          <div class="levels">
            <div class="levels-h"><span></span><span>Level</span><span>Name</span><span>Criteria</span><span>Recommended action</span><span></span></div>
            ${SEV_MODEL.map(s => `
              <div class="lvl ${s.editing ? 'editing' : ''}">
                <span class="grip">${I('grip', 's14')}</span>
                <span class="sw" style="background:${s.c}">${s.l}</span>
                <div class="ln">${s.editing ? `<input class="input" value="${s.name}" style="width:100%;margin-bottom:4px" aria-label="Level name">` : `<b>${s.name}</b>`}<span>${s.code}</span>
                  ${s.editing ? `<div class="swatches">${['var(--s5)', 'var(--s4)', 'oklch(0.80 0.15 75)', 'var(--s3)', 'var(--s2)', 'var(--s1)'].map((c, i) => `<i style="background:${c}" class="${i === 1 ? 'on' : ''}"></i>`).join('')}</div>` : ''}</div>
                <div class="lc">${s.editing ? `<textarea class="input" style="width:100%;height:62px;padding:6px 8px;resize:none;line-height:1.45" aria-label="Criteria">${s.crit}</textarea>` : s.crit}</div>
                <div class="la">${s.act}</div>
                <button class="btn icon sm ghost" title="More">${I('more', 's14')}</button>
              </div>`).join('')}
            <div class="lvl uncertain">
              <span class="grip">${I('grip', 's14')}</span><span class="sw">?</span>
              <div class="ln"><b>Uncertain</b><span>TK-U · not graded</span></div>
              <div class="lc">Not gradable from the imagery available: glare, distance, occlusion or motion blur.</div>
              <div class="la">Re-capture, or inspect manually at the next entry.</div>
              <button class="btn icon sm ghost" title="More">${I('more', 's14')}</button>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px"><button class="btn sm ghost">${I('plus', 's12')}Add level</button></div>
          <div class="preview-strip"><span class="caps faint" style="margin-right:4px">Preview</span>${SEV_MODEL.map(s => `<span class="sev s${s.l}"><i></i>${s.l} ${s.name}</span>`).join('')}<span class="sev" style="background:var(--bg-3);color:var(--fg-1)"><i style="background:repeating-linear-gradient(-45deg,var(--fg-3) 0 1.5px,transparent 1.5px 3px)"></i>? Uncertain</span><span class="faint" style="margin-left:auto;font-size:11px">Distribution in HCl: 5 ×3 · 4 ×3 · 3 ×6</span></div>
        </div>
      </div>
    </section>`;

  $('#setBody').innerHTML = ai + maps + sev;
  $$('#setBody .switch').forEach(s => s.addEventListener('click', () => { if (!s.disabled) s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true'); }));
  $$('.set-nav button[data-set]').forEach(b => b.addEventListener('click', () => showSet(b.dataset.set, b)));
  import(`./option-1-mission-map.js?v=r2`).then(m => m.drawCoverage($('#covMap'))).catch(e => console.error(e));
}
function showSet(page, btn) {
  $$('.set-page').forEach(p => p.classList.toggle('on', p.dataset.page === page));
  const target = btn || $$('.set-nav button').find(b => b.dataset.set === page && !b.dataset.anchor);
  $$('.set-nav button').forEach(b => b.setAttribute('aria-current', b === target));
  if (btn && btn.dataset.anchor) $('#' + btn.dataset.anchor).scrollIntoView({ block: 'start' }); else $('#setBody').scrollTop = 0;
}

/* ------------------------------------------------------------------ boot */
renderTree('alzour');
const start = +(location.hash || '#1').slice(1) || 1;
go(start >= 1 && start <= 4 ? start : 1);
window.__stratlas = { go, setSidebar, showSet };
