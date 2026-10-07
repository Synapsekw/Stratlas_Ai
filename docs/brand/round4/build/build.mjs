// Round 4 naming board: function-led names. Writes ../index.html and the
// symbol and app-icon SVGs under ../assets/<slug>/. Run: node build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbol, appIcon } from './marks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const FINALISTS = [
  {
    slug: 'integrum',
    name: 'Integrum',
    rank: 'Recommended',
    say: 'IN-teh-grum',
    origin: 'Latin: the whole, the untouched, the intact',
    capability: 'Asset integrity and the complete record',
    story:
      'Integrum is Latin for the whole and intact. It is the root of both integrity and integrate. Your buyers are asset-integrity managers, and the app integrates every capture of an asset into one intact record: model, point cloud, map, video, photos, findings with severity, and the signed audit journal.',
    names: ['Findings and severity models', 'Audit journal', 'Fusion of every capture'],
    taglines: ['Every asset, whole.', 'Integrity, in one view.', 'Every capture. One intact record.'],
    mark: 'Keystone. Five stones of an arch on a datum line, with the keystone raised in the accent colour. The keystone is the one piece that holds the rest together, and the arch reads as built structure, which is what your buyers look after.',
    c: { ground: '#0C141C', inkD: '#EEF2F4', accD: '#5ED1B3', paper: '#EEF2F4', inkL: '#0C141C', accL: '#1A8C70' },
    swatches: [
      ['Night steel', '#0C141C', 'Ground, title bar'],
      ['Steel', '#2E4F6E', 'Panels, charts'],
      ['Mint', '#5ED1B3', 'Accent; same hue as the current app accent'],
      ['Paper', '#EEF2F4', 'Reports, light ground'],
      ['Signal amber', '#E8A33D', 'Warnings, highlights'],
    ],
    font: { label: 'Archivo Expanded, 650, caps', css: "font-family:'Archivo',sans-serif;font-stretch:118%;font-weight:650;text-transform:uppercase;letter-spacing:.12em", scale: 0.78 },
    risk: 'low',
    screen: 'Integrum AB, a listed Swedish medical-device maker (bone-anchored implants), works in another class. No drone, GIS, inspection or reality-capture product was found.',
    domains: 'integrum.com, .ai and .io are registered. getintegrum.com is free.',
    weakness: 'The -um ending can sound like medicine or software for finance. A hard-edged mark and wordmark offset it.',
  },
  {
    slug: 'fusor',
    name: 'Fusor',
    rank: 'Runner-up',
    say: 'FEW-zor',
    origin: 'English: the machine that fuses',
    capability: 'The fusion scene',
    story:
      'Fusion is the capability that sets this product apart: models, point clouds, maps, orthomosaics, drone video with flight logs, and photos in one georeferenced scene. A fusor is the device that fuses. The name is short and hard-sounding, like Palantir or Anduril, and it is the most direct name on this board.',
    names: ['Fusion scene', 'Video projected on models', 'Models on maps'],
    taglines: ['Fuse every capture.', 'Video, model, map. Fused.', 'One scene from every sensor.'],
    mark: 'Converging rays. Three capture rays (model, map and video) enter one ring and meet at a bright core. At 16 px it still reads as a ring with a centre.',
    c: { ground: '#0F1016', inkD: '#ECEAF4', accD: '#B47CFF', paper: '#F4F3F8', inkL: '#15141C', accL: '#7B45E0' },
    swatches: [
      ['Graphite', '#0F1016', 'Ground, title bar'],
      ['Plasma', '#B47CFF', 'Accent: the glow of a running fusor'],
      ['Ice', '#9CC7FF', 'Secondary, selection'],
      ['Paper', '#F4F3F8', 'Reports, light ground'],
      ['Slate', '#4B4F63', 'Lines, quiet text'],
    ],
    font: { label: 'Unbounded, 600, lowercase', css: "font-family:'Unbounded',sans-serif;font-weight:600;letter-spacing:-.01em", scale: 0.9 },
    risk: 'medium',
    screen: 'A fusor is a known nuclear-fusion device, so search results lean to physics. Near-names: Fuusor (Finnish BI software) and Fusus (Axon, public-safety video). No drone or geospatial product was found.',
    domains: 'fusor.com, .ai and .io are registered. getfusor.com and fusorhq.com are free.',
    weakness: 'The physics meaning dominates search, so the name needs the company beside it at launch ("Fusor by Synapse").',
  },
  {
    slug: 'syncline',
    name: 'Syncline',
    rank: 'Plain-English pick',
    say: 'SIN-kline',
    origin: 'Geology: a fold where rock layers bend down together',
    capability: 'Timeline, video sync and team sync',
    story:
      'A syncline is a fold in which strata bend down together. The word contains sync: drone video synced to its flight log, every layer on one timeline, and the team sync that arrived in 0.9.0. Oil and gas engineers already know the word, and it keeps the layered idea behind Stratlas.',
    names: ['Video and flight-log sync', 'One timeline', 'Team sync'],
    taglines: ['Every capture, in sync.', 'Video, flight, model, map. One timeline.', 'Layers that move together.'],
    mark: 'Block diagram. The way geologists draw a syncline: a block whose front face shows three strata folded down together and whose side carries them back. The middle layer, the one in sync, is in the accent colour. It reads as layers and as a 3D model.',
    c: { ground: '#17181C', inkD: '#EAE3D4', accD: '#E3C14B', paper: '#F1ECE2', inkL: '#1D1E22', accL: '#A3801A' },
    swatches: [
      ['Bitumen', '#17181C', 'Ground, title bar'],
      ['Sandstone', '#E3C14B', 'Accent, the synced layer'],
      ['Strata teal', '#3F8C84', 'Secondary, charts'],
      ['Limestone', '#F1ECE2', 'Reports, light ground'],
      ['Shale', '#6E6A64', 'Lines, quiet text'],
    ],
    font: { label: 'Red Hat Display, 650, lowercase', css: "font-family:'Red Hat Display',sans-serif;font-weight:650;letter-spacing:-.015em", scale: 1 },
    risk: 'medium',
    screen: 'Syncline is a small open-source sync tool for Obsidian notes, and was the name of a 1997 government decision-support vendor. It is also a wine label. No drone or GIS product was found.',
    domains: 'syncline.com, .ai and .io are registered. getsyncline.com and synclinehq.com are free.',
    weakness: 'It is a geology word and says nothing about drones or inspection. Strong in oil and gas, flat elsewhere.',
  },
  {
    slug: 'alidade',
    name: 'Alidade',
    rank: 'Finalist',
    say: 'AL-ih-dayd',
    origin: "Surveying: the sighting rule of the surveyor's instruments",
    capability: 'Sighting, measuring and surveys',
    story:
      "The alidade is the sighting rule on a plane table or theodolite. You aim it, read the angle, and record what you saw. The app does the same at drone scale: camera poses and view cones, measurements, volumetric and road surveys, and findings pinned where they were seen.",
    names: ['Camera poses and view cones', 'Measurements', 'Volumetric and road surveys'],
    taglines: ['Sight it. Measure it. Prove it.', 'Precision from every vantage.', "The surveyor's sightline, rebuilt for drones."],
    mark: 'Sighting rule. A rule with two sight vanes pivots on a graduated ring and points at the sighted point. The red comes from survey ranging poles.',
    c: { ground: '#0F1A2E', inkD: '#F4F5F7', accD: '#EF5B4C', paper: '#F4F5F7', inkL: '#0F1A2E', accL: '#D2402F' },
    swatches: [
      ['Navy', '#0F1A2E', 'Ground, title bar'],
      ['Survey red', '#EF5B4C', 'Accent: ranging-pole red'],
      ['Pole white', '#F4F5F7', 'Reports, light ground'],
      ['Brass', '#C8973F', 'Secondary, instrument detail'],
      ['Graphite', '#5B6475', 'Lines, quiet text'],
    ],
    font: { label: 'Michroma, caps', css: "font-family:'Michroma',sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.08em", scale: 0.66 },
    risk: 'low',
    screen: 'The only use found is a small Apple app for exploring Minecraft maps. It is a standard surveying term, so counsel needs to confirm it can be registered for software.',
    domains: 'alidade.com, .ai, .io and getalidade.com are registered. alidadehq.com and alidadeapp.com are free.',
    weakness: 'Most people do not know the word, and the stress is not obvious. It needs a one-line story in onboarding.',
  },
  {
    slug: 'chronotope',
    name: 'Chronotope',
    rank: 'Finalist',
    say: 'KRON-oh-tope',
    origin: 'Greek chronos + topos: time-place',
    capability: 'Compare dates and change detection',
    story:
      'Chronotope means time-place: the idea that where and when are read together. The app shows every capture where and when it was taken, compares survey dates side by side, and detects change between them. It is the cleanest name on this board in the screen.',
    names: ['Compare dates', 'Change detection', 'The 4D timeline'],
    taglines: ['Every place, every date.', 'Where and when, in one view.', 'See what changed, and where.'],
    mark: 'Half map, half clock. The left half of the dial is a graticule and the right half is a clock face. One hand in the accent colour joins them.',
    c: { ground: '#0A1022', inkD: '#E9EEF8', accD: '#5B8CFF', paper: '#EEF2FA', inkL: '#0A1022', accL: '#2F5BE0' },
    swatches: [
      ['Midnight', '#0A1022', 'Ground, title bar'],
      ['Cobalt', '#5B8CFF', 'Accent, the clock hand'],
      ['Dawn', '#F2B53A', 'Secondary: the other date'],
      ['Ice', '#EEF2FA', 'Reports, light ground'],
      ['Dusk', '#6B7699', 'Lines, quiet text'],
    ],
    font: { label: 'Bricolage Grotesque, 650, lowercase', css: "font-family:'Bricolage Grotesque',sans-serif;font-weight:650;font-variation-settings:'opsz' 96;letter-spacing:-.02em", scale: 0.92 },
    risk: 'low',
    screen: 'No product or company was found. Near-names are Chronoscope (time-tracking software) and CronoTopia (a Google Workspace add-on). It is a known term in literary theory.',
    domains: 'chronotope.com, .ai and .io are registered. getchronotope.com, chronotopehq.com and chronotopeapp.com are free.',
    weakness: 'Four syllables, and it sounds academic. People will misspell it after hearing it once.',
  },
  {
    slug: 'isoline',
    name: 'Isoline',
    rank: 'Finalist',
    say: 'EYE-so-line',
    origin: 'Cartography: a line through points of equal value',
    capability: 'Elevation, volumes and surface change',
    story:
      'An isoline joins points of equal value: contours of height, or lines of equal change. It names the survey side of the app: elevation ramps, stockpile volumes, road condition and the change surfaces between two dates.',
    names: ['Elevation ramps', 'Stockpile volumes', 'Surface change'],
    taglines: ['Measure what changed.', 'Every surface, every volume, every date.', 'Read the ground.'],
    mark: 'Contours round a summit. Four contour lines climbing to a peak, with the line that changed in the accent colour. The orange is the brown-orange of contours on a topographic map.',
    c: { ground: '#13241B', inkD: '#EEF2EC', accD: '#E07B39', paper: '#F1F4EF', inkL: '#13241B', accL: '#C25E1C' },
    swatches: [
      ['Forest', '#13241B', 'Ground, title bar'],
      ['Contour', '#E07B39', 'Accent, the changed line'],
      ['Lake', '#3F86AE', 'Secondary, water and cut'],
      ['Mist', '#F1F4EF', 'Reports, light ground'],
      ['Moss', '#6F8F6A', 'Lines, quiet text'],
    ],
    font: { label: 'Saira Semi Condensed, 600, lowercase', css: "font-family:'Saira Semi Condensed',sans-serif;font-weight:600;letter-spacing:.01em", scale: 1.05 },
    risk: 'low',
    screen: 'No product or company was found. It is a standard term in cartography and in routing APIs, so it may be hard to register or enforce.',
    domains: 'isoline.com, .ai, .io and isolinehq.com are registered. getisoline.com and isolineapp.com are free.',
    weakness: 'It is descriptive. It sounds like a feature inside a GIS rather than a platform.',
  },
];

// capability map: which product capability each screened name came from
const FAMILIES = [
  { title: 'Fusion and the whole record', body: 'One scene for every capture of an asset.', names: ['Integrum', 'Fusor', 'Omnisite', 'Holoscene', 'Tessellate', 'Twinsite'] },
  { title: 'Time, sync and the timeline', body: 'Video synced to flight logs, every layer on one clock.', names: ['Syncline', 'Chronotope', 'Keyframe', 'Sidereal', 'Tetrad'] },
  { title: 'Survey and measurement', body: 'Poses, measurements, volumes, roads, elevation.', names: ['Alidade', 'Isoline', 'Sextant', 'Traverse', 'Gimbal', 'Plumbline', 'Fuselage'] },
  { title: 'Inspection evidence and oversight', body: 'Findings, severity, the audit trail and reports.', names: ['Assay', 'Fieldmark', 'Oversite', 'Dossier', 'Custos', 'Highground'] },
];

const LONGLIST = [
  ['Integrum', 'Fusion', 'Latin for the whole and intact; root of integrity', 'low', 'Integrum AB (medical implants, other class)', 'Finalist'],
  ['Fusor', 'Fusion', 'The device that fuses', 'medium', 'Nuclear-fusion device; Fuusor (BI), Fusus (Axon video)', 'Finalist'],
  ['Omnisite', 'Fusion', 'Every capture of one site', 'medium', 'omniSite website builder; more OmniSite marks likely', 'Dropped: crowded'],
  ['Holoscene', 'Fusion', 'The whole scene', 'high', 'HoloForge HoloScene, a 3D and XR scene builder', 'Dropped: collision'],
  ['Tessellate', 'Fusion', 'Tiles fitted into one surface', 'medium', 'Tessl and Tessell near; a standard mesh term', 'Dropped: crowded'],
  ['Twinsite', 'Fusion', 'Digital twin of a site', 'high', 'TwinSite (construction digital twin); Twinsity TWINSPECT (drone inspection)', 'Dropped: collision'],
  ['Syncline', 'Time', 'Fold of strata; contains sync', 'medium', 'Syncline Obsidian sync tool (open source)', 'Finalist'],
  ['Chronotope', 'Time', 'Time-place', 'low', 'None found; Chronoscope near', 'Finalist'],
  ['Keyframe', 'Time', 'A defining frame on the timeline', 'high', 'Many Keyframe apps on both stores; generic term', 'Dropped: collision'],
  ['Sidereal', 'Time', 'Star time', 'medium', 'Sidereal Solutions (government satcom and IT)', 'Dropped: weak fit'],
  ['Tetrad', 'Time', 'Four: three dimensions plus time', 'medium', 'Tetrad causal-modelling software (Carnegie Mellon)', 'Dropped: collision'],
  ['Alidade', 'Survey', 'The sighting rule', 'low', 'A small Minecraft-map app', 'Finalist'],
  ['Isoline', 'Survey', 'Line of equal value; contours', 'low', 'None found; descriptive in GIS', 'Finalist'],
  ['Sextant', 'Survey', 'Instrument for measuring angles', 'high', 'Sextant Avionique (Thales); Sextant geospatial platform', 'Dropped: collision'],
  ['Traverse', 'Survey', 'A survey traverse', 'high', 'Traverse3D (drone digital twins); Traverse PC (survey software)', 'Dropped: collision'],
  ['Gimbal', 'Survey', 'The drone camera mount', 'high', 'Gimbal location platform; a generic drone part', 'Dropped: collision'],
  ['Plumbline', 'Survey', 'The true vertical', 'medium', 'PlumbLine level apps; plumbing software', 'Dropped: crowded'],
  ['Fuselage', 'Survey', 'Fuse + aircraft body', 'high', 'Fuselage Innovations (drones, defence)', 'Dropped: collision'],
  ['Assay', 'Evidence', 'A test of quality', 'medium', 'Assay Depot and other lab software; generic', 'Dropped: crowded'],
  ['Fieldmark', 'Evidence', 'A mark that identifies in the field', 'high', 'Offline field-capture app on the App Store', 'Dropped: collision'],
  ['Oversite', 'Evidence', 'Oversight of a site', 'high', 'Oversite construction-inspection software', 'Dropped: collision'],
  ['Dossier', 'Evidence', 'The complete file on an asset', 'medium', 'Several Dossier apps; generic word', 'Dropped: crowded'],
  ['Custos', 'Evidence', 'Latin for guardian', 'medium', 'Custos Tech (compliance), Custos Media', 'Dropped: crowded'],
  ['Highground', 'Evidence', 'The commanding view', 'high', 'HighGround (defence AI, funded 2026)', 'Dropped: collision'],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const riskChip = (r) => `<span class="chip risk-${r}">${r === 'low' ? 'Low risk' : r === 'medium' ? 'Medium risk' : 'High risk'}</span>`;

// ---------- export SVG files ----------
for (const F of FINALISTS) {
  const dir = join(root, 'assets', F.slug);
  mkdirSync(dir, { recursive: true });
  const x = 'xmlns="http://www.w3.org/2000/svg"';
  writeFileSync(join(dir, 'symbol-dark.svg'), symbol(F.slug, { ink: F.c.inkD, acc: F.c.accD }, 512).replace(x, x));
  writeFileSync(join(dir, 'symbol-light.svg'), symbol(F.slug, { ink: F.c.inkL, acc: F.c.accL }, 512));
  writeFileSync(join(dir, 'symbol-mono.svg'), symbol(F.slug, { ink: '#000000', acc: '#000000' }, 512));
  writeFileSync(join(dir, 'appicon.svg'), appIcon(F.slug, { ground: F.c.ground, ink: F.c.inkD, acc: F.c.accD }, 1024));
}

// ---------- page pieces ----------
function lockup(F, ink, acc, size = 52) {
  return `<div class="lockup">${symbol(F.slug, { ink, acc }, size)}<span class="wm" style="${F.font.css};color:${ink};font-size:${(size * 0.62 * F.font.scale).toFixed(1)}px">${esc(F.name)}</span></div>`;
}

function stage(F) {
  const { ground, inkD, accD } = F.c;
  // synthetic tank on a perspective grid, a flight path and three findings
  const grid = [];
  for (let i = 0; i <= 10; i++) {
    const xb = -40 + i * 40, xt = 110 + i * 10;
    grid.push(`<line x1="${xb}" y1="150" x2="${xt}" y2="78" />`);
  }
  for (const y of [86, 98, 114, 134]) grid.push(`<line x1="0" y1="${y}" x2="320" y2="${y}" />`);
  return `<svg viewBox="0 0 320 150" class="stage-svg" aria-hidden="true">
    <rect width="320" height="150" fill="${ground}"/>
    <g stroke="${inkD}" stroke-opacity=".12" stroke-width="1">${grid.join('')}</g>
    <g fill="${inkD}" fill-opacity=".16" stroke="${inkD}" stroke-opacity=".45" stroke-width="1">
      <path d="M128 52 V104 A32 9 0 0 0 192 104 V52"/><ellipse cx="160" cy="52" rx="32" ry="9"/>
    </g>
    <path d="M40 40 C90 18 140 22 176 30 S260 50 290 30" fill="none" stroke="${accD}" stroke-width="1.6" stroke-dasharray="4 3"/>
    <path d="M176 30 L150 68 L196 70 Z" fill="${accD}" fill-opacity=".14" stroke="${accD}" stroke-opacity=".55" stroke-width=".8"/>
    <circle cx="176" cy="30" r="3.2" fill="${accD}"/>
    <g stroke="${ground}" stroke-width="1.2"><circle cx="146" cy="76" r="4.2" fill="#E5484D"/><circle cx="178" cy="92" r="4.2" fill="#F59E0B"/><circle cx="168" cy="62" r="4.2" fill="#EAB308"/></g>
  </svg>`;
}

function contexts(F) {
  const { ground, inkD, accD, paper, inkL, accL } = F.c;
  return `<div class="ctx">
    <figure class="ctx-win" style="--g:${ground};--i:${inkD};--a:${accD}">
      <div class="tb">${appIcon(F.slug, { ground, ink: inkD, acc: accD }, 16)}<span class="tb-name" style="${F.font.css};font-size:${(11 * F.font.scale).toFixed(1)}px">${esc(F.name)}</span><span class="tb-proj">Tank T-101 · synthetic sample</span><span class="tb-dots"><i></i><i></i><i></i></span></div>
      <div class="wbody"><div class="rail">${symbol(F.slug, { ink: inkD, acc: accD }, 18)}<i></i><i></i><i></i><i></i></div><div class="st">${stage(F)}<div class="tl"><span class="tl-track"></span><span class="tl-head"></span></div></div></div>
      <figcaption>App window, dark title bar</figcaption>
    </figure>
    <figure class="ctx-splash" style="background:${ground};color:${inkD}">
      <div class="splash-in">${symbol(F.slug, { ink: inkD, acc: accD }, 54)}<div class="splash-name" style="${F.font.css};font-size:${(26 * F.font.scale).toFixed(1)}px">${esc(F.name)}</div><div class="splash-tag">${esc(F.taglines[0])}</div><div class="splash-ver">Version 0.9.0 · Synapse Solutions</div></div>
      <figcaption style="color:${inkD}">Splash</figcaption>
    </figure>
    <figure class="ctx-report" style="background:${paper};color:${inkL}">
      <div class="rep-head">${symbol(F.slug, { ink: inkL, acc: accL }, 20)}<span style="${F.font.css};font-size:${(11 * F.font.scale).toFixed(1)}px">${esc(F.name)}</span></div>
      <div class="rep-bar" style="background:${accL}"></div>
      <div class="rep-title">Integrity review</div>
      <div class="rep-sub">Tank T-101 · synthetic sample</div>
      <div class="rep-date">October 2026</div>
      <figcaption>Report cover</figcaption>
    </figure>
  </div>`;
}

function finalist(F, i) {
  const { ground, inkD, accD, paper, inkL, accL } = F.c;
  const iconD = (s) => appIcon(F.slug, { ground, ink: inkD, acc: accD }, s);
  const iconL = (s) => appIcon(F.slug, { ground: paper, ink: inkL, acc: accL }, s);
  return `<article class="fin" id="${F.slug}">
  <header class="fin-head">
    <div class="fin-title"><span class="rank">${i + 1} · ${esc(F.rank)}</span><h3>${esc(F.name)}</h3><span class="say">${esc(F.say)}</span></div>
    <div class="fin-chips">${riskChip(F.risk)}<span class="chip">${esc(F.capability)}</span></div>
  </header>
  <div class="fin-grid">
    <div class="specimens">
      <div class="hero-ground" style="background:${ground}">${lockup(F, inkD, accD, 60)}</div>
      <div class="grounds">
        <div class="gr" style="background:${paper}">${lockup(F, inkL, accL, 34)}</div>
        <div class="gr" style="background:#ffffff">${symbol(F.slug, { ink: '#000', acc: '#000' }, 44)}<span class="gr-l" style="color:#000">Mono</span></div>
        <div class="gr" style="background:#000000">${symbol(F.slug, { ink: '#fff', acc: '#fff' }, 44)}<span class="gr-l" style="color:#fff">Mono reversed</span></div>
      </div>
      <div class="icons">
        <div class="icon-row">${iconD(96)}${iconD(48)}${iconD(32)}${iconD(16)}</div>
        <div class="icon-row light">${iconL(48)}${iconL(32)}${iconL(16)}</div>
        <p class="note">App icon at 96, 48, 32 and 16 px, on its own ground and on paper.</p>
      </div>
    </div>
    <div class="facts">
      <p class="origin">${esc(F.origin)}</p>
      <p>${esc(F.story)}</p>
      <h4>What it names in the app</h4>
      <ul class="tags">${F.names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      <h4>Taglines</h4>
      <ol class="taglines">${F.taglines.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
      <h4>Mark</h4>
      <p>${esc(F.mark)}</p>
      <h4>Colour</h4>
      <ul class="swatches">${F.swatches.map(([n, hex, role]) => `<li><span class="sw" style="background:${hex}"></span><span class="sw-n">${esc(n)}</span><span class="sw-h">${hex}</span><span class="sw-r">${esc(role)}</span></li>`).join('')}</ul>
      <h4>Type</h4>
      <p class="type-spec"><span style="${F.font.css};font-size:${(22 * F.font.scale).toFixed(1)}px">${esc(F.name)}</span><span class="note">${esc(F.font.label)}. The final wordmark would be redrawn as outlines.</span></p>
      <h4>Screen</h4>
      <dl class="kv"><dt>Collisions</dt><dd>${esc(F.screen)}</dd><dt>Domains</dt><dd>${esc(F.domains)}</dd><dt>Watch out</dt><dd>${esc(F.weakness)}</dd></dl>
    </div>
  </div>
  <h4 class="ctx-h">In context</h4>
  ${contexts(F)}
</article>`;
}

const status = Object.fromEntries(LONGLIST.map((r) => [r[0], r[5].startsWith('Finalist') ? 'fin' : 'out']));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Naming Round 4</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Michroma&family=Red+Hat+Display:wght@400..800&family=Saira+Semi+Condensed:wght@500;600;700&family=Unbounded:wght@400..700&display=swap">
<style>
/* Layout: a board of six spec sheets, each one candidate shown as a brand would ship it.
   Chrome uses the app's Mission neutrals so the candidates' own colours carry the page. */
:root{
  color-scheme:dark;
  --bg-0:oklch(0.145 0.008 250);--bg-1:oklch(0.175 0.009 250);--bg-2:oklch(0.205 0.010 250);
  --line:oklch(0.275 0.011 250);--line-soft:oklch(0.225 0.010 250);
  --fg-0:oklch(0.945 0.006 250);--fg-1:oklch(0.800 0.010 250);--fg-2:oklch(0.680 0.012 250);
  --acc:oklch(0.790 0.115 172);--acc-a12:oklch(0.790 0.115 172 / .12);
  --ok:oklch(0.780 0.110 155);--warn:oklch(0.840 0.140 92);--bad:oklch(0.700 0.170 25);
  --f-ui:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;--f-mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;
}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){
  color-scheme:light;--bg-0:oklch(0.955 0.004 250);--bg-1:oklch(0.990 0.002 250);--bg-2:oklch(0.940 0.005 250);
  --line:oklch(0.860 0.008 250);--line-soft:oklch(0.910 0.006 250);
  --fg-0:oklch(0.200 0.010 250);--fg-1:oklch(0.330 0.012 250);--fg-2:oklch(0.470 0.012 250);
  --acc:oklch(0.500 0.100 172);--acc-a12:oklch(0.500 0.100 172 / .10);
  --ok:oklch(0.500 0.120 155);--warn:oklch(0.560 0.120 80);--bad:oklch(0.540 0.180 25);
}}
:root[data-theme="light"]{
  color-scheme:light;--bg-0:oklch(0.955 0.004 250);--bg-1:oklch(0.990 0.002 250);--bg-2:oklch(0.940 0.005 250);
  --line:oklch(0.860 0.008 250);--line-soft:oklch(0.910 0.006 250);
  --fg-0:oklch(0.200 0.010 250);--fg-1:oklch(0.330 0.012 250);--fg-2:oklch(0.470 0.012 250);
  --acc:oklch(0.500 0.100 172);--acc-a12:oklch(0.500 0.100 172 / .10);
  --ok:oklch(0.500 0.120 155);--warn:oklch(0.560 0.120 80);--bad:oklch(0.540 0.180 25);
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg-0);color:var(--fg-1);font:15px/1.6 var(--f-ui);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.wrap{max-width:1240px;margin:0 auto;padding-inline:max(16px,env(safe-area-inset-left)) max(16px,env(safe-area-inset-right))}
@media (min-width:700px){.wrap{padding-inline:32px}}
header.top{border-bottom:1px solid var(--line);background:var(--bg-1)}
header.top .wrap{display:flex;align-items:center;gap:16px;min-height:52px;flex-wrap:wrap}
.eyebrow,h4,.rank,.chip,.note-mono{font:500 11px/1.3 var(--f-mono);letter-spacing:.08em;text-transform:uppercase}
.eyebrow{color:var(--fg-2)}
.theme-btn{margin-left:auto;font:500 12px var(--f-ui);color:var(--fg-1);background:var(--bg-2);border:1px solid var(--line);border-radius:4px;padding:5px 12px;cursor:pointer}
.theme-btn:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
h1{font-size:clamp(28px,4.5vw,40px);line-height:1.12;font-weight:600;color:var(--fg-0);letter-spacing:-.018em;margin:18px 0 14px;text-wrap:balance;max-width:24ch}
h2{font-size:22px;font-weight:600;color:var(--fg-0);margin:0 0 6px;letter-spacing:-.01em;text-wrap:balance}
h3{font-size:30px;line-height:1.1;font-weight:600;color:var(--fg-0);margin:0;letter-spacing:-.015em}
h4{color:var(--fg-2);margin:22px 0 8px}
p{margin:0 0 10px;max-width:68ch}
a{color:var(--acc)}
section{padding-block:40px;border-bottom:1px solid var(--line-soft)}
.lede{font-size:16.5px;color:var(--fg-1);max-width:70ch}
.note{font-size:12.5px;color:var(--fg-2)}
.chip{display:inline-flex;align-items:center;padding:4px 8px;border:1px solid var(--line);border-radius:3px;color:var(--fg-1);white-space:nowrap}
.risk-low{color:var(--ok);border-color:color-mix(in oklab,var(--ok) 45%,transparent)}
.risk-medium{color:var(--warn);border-color:color-mix(in oklab,var(--warn) 45%,transparent)}
.risk-high{color:var(--bad);border-color:color-mix(in oklab,var(--bad) 45%,transparent)}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13.5px;margin-top:18px}
nav.toc a{color:var(--fg-2);text-decoration:none}nav.toc a:hover{color:var(--fg-0)}

/* recommendation */
.rec{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:28px;align-items:center;margin-top:24px;padding:24px;border:1px solid var(--acc);background:var(--acc-a12);border-radius:6px}
.rec-visual{border-radius:6px;padding:28px 20px;display:flex;justify-content:center}
.rec ul{margin:8px 0 0;padding-left:18px}.rec li{margin-bottom:6px;max-width:66ch}
@media (max-width:780px){.rec{grid-template-columns:1fr}}

/* overview strip */
.strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:22px}
.strip a{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 8px 14px;border-radius:6px;text-decoration:none;border:1px solid transparent}
.strip a:hover{border-color:var(--line)}
.strip .s-name{font-size:13px;font-weight:600}
.strip .s-cap{font-size:11.5px;text-align:center;opacity:.75;line-height:1.35}
@media (max-width:980px){.strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:520px){.strip{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* families */
.fam{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:20px}
.fam > div{border:1px solid var(--line);background:var(--bg-1);border-radius:6px;padding:16px;min-width:0}
.fam h3{font-size:15px;margin-bottom:4px}
.fam p{font-size:13px;color:var(--fg-2)}
.fam ul{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.fam li{font-size:12.5px;padding:2px 8px;border-radius:3px;border:1px solid var(--line-soft);color:var(--fg-2)}
.fam li.fin{color:var(--fg-0);border-color:var(--acc);background:var(--acc-a12);font-weight:600}
.fam li.out{text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--fg-2) 60%,transparent)}
@media (max-width:980px){.fam{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:520px){.fam{grid-template-columns:1fr}}

/* finalist sheet */
.fin{padding-block:48px;border-bottom:1px solid var(--line)}
.fin-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;justify-content:space-between;margin-bottom:20px}
.fin-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px}
.rank{color:var(--acc);width:100%}
.say{font:400 14px var(--f-mono);color:var(--fg-2)}
.fin-chips{display:flex;gap:8px;flex-wrap:wrap}
.fin-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:32px}
@media (max-width:940px){.fin-grid{grid-template-columns:1fr}}
.specimens{display:grid;gap:10px;align-content:start;min-width:0}
.hero-ground{border-radius:6px;min-height:200px;display:flex;align-items:center;justify-content:center;padding:28px 16px}
.grounds{display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:10px}
.gr{border-radius:6px;min-height:104px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px 8px;border:1px solid var(--line-soft)}
.gr-l{font:500 10px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;opacity:.7}
@media (max-width:560px){.grounds{grid-template-columns:1fr 1fr}.grounds .gr:first-child{grid-column:1 / -1}}
.lockup{display:flex;align-items:center;gap:.5em;flex-wrap:nowrap;max-width:100%}
.lockup svg{flex:none}
.wm{line-height:1;white-space:nowrap}
.icons{border:1px solid var(--line);background:var(--bg-1);border-radius:6px;padding:14px}
.icon-row{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.icon-row.light{margin-top:12px;padding:10px;border-radius:4px;background:#eef0f2}
.icons .note{margin:10px 0 0}
.facts{min-width:0}
.facts .origin{font:500 13px var(--f-mono);color:var(--fg-0)}
.tags{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.tags li{font-size:13px;padding:3px 9px;border:1px solid var(--line);border-radius:3px;color:var(--fg-1)}
.taglines{margin:0;padding-left:20px;color:var(--fg-0);font-size:16px;font-weight:500}
.taglines li{margin-bottom:4px}
.swatches{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.swatches li{display:grid;grid-template-columns:28px 112px 74px minmax(0,1fr);gap:10px;align-items:center;font-size:13px}
.sw{width:28px;height:28px;border-radius:4px;border:1px solid var(--line)}
.sw-n{color:var(--fg-0);font-weight:500}
.sw-h{font:12px var(--f-mono);color:var(--fg-2);font-variant-numeric:tabular-nums}
.sw-r{color:var(--fg-2);font-size:12.5px}
@media (max-width:520px){.swatches li{grid-template-columns:28px minmax(0,1fr) auto}.sw-r{grid-column:2 / -1}}
.type-spec{display:flex;flex-direction:column;gap:4px}
.type-spec > span:first-child{color:var(--fg-0)}
dl.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 14px;margin:0;font-size:13.5px}
dl.kv dt{color:var(--fg-2)}dl.kv dd{margin:0}

/* in context */
.ctx-h{margin-top:30px}
.ctx{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) minmax(0,.8fr);gap:12px}
@media (max-width:940px){.ctx{grid-template-columns:1fr 1fr}.ctx-win{grid-column:1 / -1}}
@media (max-width:520px){.ctx{grid-template-columns:1fr}}
.ctx figure{margin:0;border-radius:6px;overflow:hidden;position:relative;border:1px solid var(--line);min-width:0}
.ctx figcaption{position:absolute;right:8px;bottom:6px;font:500 10px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;opacity:.55}
.ctx-win{background:var(--g);color:var(--i)}
.tb{display:flex;align-items:center;gap:8px;height:30px;padding:0 10px;border-bottom:1px solid color-mix(in oklab,var(--i) 12%,transparent);background:color-mix(in oklab,var(--g) 85%,#000)}
.tb-name{white-space:nowrap}
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
.ctx-splash{display:flex;align-items:center;justify-content:center;min-height:220px}
.splash-in{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 12px 26px;text-align:center}
.splash-name{line-height:1;margin-top:4px}
.splash-tag{font-size:13px;opacity:.85}
.splash-ver{font:11px var(--f-mono);opacity:.5;margin-top:6px}
.ctx-report{padding:16px 16px 30px;display:flex;flex-direction:column;min-height:220px}
.rep-head{display:flex;align-items:center;gap:6px}
.rep-bar{height:4px;width:44px;margin-top:auto;margin-bottom:10px}
.rep-title{font-size:19px;font-weight:600;line-height:1.15}
.rep-sub{font-size:12px;opacity:.7;margin-top:4px}
.rep-date{font:11px var(--f-mono);opacity:.6;margin-top:10px}

/* longlist */
.tbl{overflow-x:auto;margin-top:18px;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;min-width:760px;font-size:13.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{font:500 11px var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--fg-2);background:var(--bg-1)}
td:first-child{color:var(--fg-0);font-weight:600;white-space:nowrap}
tr.is-fin td{background:var(--acc-a12)}
ul.plain{margin:6px 0 0;padding-left:18px}ul.plain li{margin-bottom:6px;max-width:72ch}
footer{padding-block:28px;font-size:12.5px;color:var(--fg-2)}
@media (prefers-reduced-motion:no-preference){.strip a{transition:border-color .15s}}
</style>
</head>
<body>
<header class="top"><div class="wrap"><span class="eyebrow">Synapse Solutions · Brand · Round 4 · 7 Oct 2026</span><button class="theme-btn" id="theme-btn" type="button">Theme: auto</button></div></header>
<main class="wrap">
<section>
  <h1>Names that say what the product does</h1>
  <p class="lede">Rounds 1 to 3 looked for weight and heritage. This round starts from the product's capabilities instead: the fusion scene, the timeline and its sync, survey and measurement, and inspection evidence. Every name comes from one of those, and every name is international. No name from rounds 1 to 3 is reused.</p>
  <p class="note">This is a quick screen, not legal clearance. Collisions were checked with web searches on 7 Oct 2026, and domains with live RDAP queries to the .com, .ai and .io registries. No trademark register was searched. Counsel must clear the pick in classes 9 and 42 before anything is bought or printed.</p>
  <div class="strip">${FINALISTS.map((F) => `<a href="#${F.slug}" style="background:${F.c.ground};color:${F.c.inkD}">${appIcon(F.slug, { ground: F.c.ground, ink: F.c.inkD, acc: F.c.accD }, 56)}<span class="s-name">${esc(F.name)}</span><span class="s-cap">${esc(F.capability)}</span></a>`).join('')}</div>
  <nav class="toc"><a href="#recommendation">Recommendation</a><a href="#capabilities">Where the names came from</a>${FINALISTS.map((F) => `<a href="#${F.slug}">${esc(F.name)}</a>`).join('')}<a href="#longlist">Longlist</a><a href="#method">Method</a></nav>
</section>

<section id="recommendation">
  <h2>Recommendation: Integrum, with the Keystone mark</h2>
  <div class="rec">
    <div class="rec-visual" style="background:${FINALISTS[0].c.ground}">${lockup(FINALISTS[0], FINALISTS[0].c.inkD, FINALISTS[0].c.accD, 56)}</div>
    <div>
      <ul>
        <li><strong>It names the buyer's job.</strong> The people who sign for this are asset-integrity managers. Integrum is the Latin root of integrity.</li>
        <li><strong>It names what the app does.</strong> The same root gives integrate: every capture of an asset brought into one intact record.</li>
        <li><strong>It has weight.</strong> Three syllables, Latin, hard consonants. It sits beside Palantir and Lattice without copying them.</li>
        <li><strong>It has the cleanest screen of the strong names.</strong> The only notable holder is a medical-device maker in another class. getintegrum.com is free.</li>
        <li><strong>It needs no UI repaint.</strong> Its mint accent is the same hue as the app's current accent.</li>
      </ul>
      <p class="note" style="margin-top:12px">If you want the shortest, hardest name, take <strong>Fusor</strong>, but launch it as "Fusor by Synapse" until it owns its search results. If you want plain English with the timeline story, take <strong>Syncline</strong>.</p>
    </div>
  </div>
</section>

<section id="capabilities">
  <h2>Where the names came from</h2>
  <p>24 names were generated from four capability groups and screened. Six finalists are highlighted. Struck names failed the screen.</p>
  <div class="fam">${FAMILIES.map((g) => `<div><h3>${esc(g.title)}</h3><p>${esc(g.body)}</p><ul>${g.names.map((n) => `<li class="${status[n] || 'out'}">${esc(n)}</li>`).join('')}</ul></div>`).join('')}</div>
</section>

${FINALISTS.map(finalist).join('\n')}

<section id="longlist">
  <h2>Longlist: 24 names screened</h2>
  <p>Risk is HIGH when a holder works in our field (drones, geospatial, inspection, digital twins, defence) or is a famous brand.</p>
  <div class="tbl"><table>
    <thead><tr><th>Name</th><th>Group</th><th>Idea</th><th>Risk</th><th>Strongest collision found</th><th>Verdict</th></tr></thead>
    <tbody>${LONGLIST.map(([n, g, idea, r, col, v]) => `<tr class="${v === 'Finalist' ? 'is-fin' : ''}"><td>${esc(n)}</td><td>${esc(g)}</td><td>${esc(idea)}</td><td>${riskChip(r)}</td><td>${esc(col)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody>
  </table></div>
</section>

<section id="method">
  <h2>Method and limits</h2>
  <ul class="plain">
    <li>Names came from the PRD's capabilities, not from myth. Names from rounds 1 to 3 were excluded. On your instruction, Arabic names were removed from the round.</li>
    <li>Each name had two or three web searches against software, drones, geospatial, reality capture, inspection, oil and gas, defence and AI, and against both app stores. The search engine is US-centred and recall is thin, so "none found" does not mean clear.</li>
    <li>Domains were checked live with RDAP on 7 Oct 2026 (Verisign for .com, Identity Digital for .ai and .io). Every bare .com on the list is registered, so each finalist shows a free fallback. Raw results are in rdap-results.txt.</li>
    <li>Marks are hand-placed SVG on a 64-unit grid, and each works in one colour. Wordmarks are set in Google Fonts for this board. The chosen one would be redrawn as outlines.</li>
    <li>Next steps: you pick one; counsel clears it in classes 9 and 42 in the US, EU and GCC; we secure the fallback domain and handles; then packages/brand is updated. Stratlas stays the working name until then.</li>
  </ul>
  <p class="note">Files: assets/&lt;name&gt;/symbol-dark.svg, symbol-light.svg, symbol-mono.svg and appicon.svg (1024 px) · build/build.mjs and build/marks.mjs regenerate this page.</p>
</section>
</main>
<footer><div class="wrap">Synapse Solutions · Round 4 naming board · quick screen, not legal clearance · all scene and report content is synthetic.</div></footer>
<script>
(function(){
  var b=document.getElementById('theme-btn'),modes=['auto','dark','light'],i=0;
  try{var s=localStorage.getItem('r4-theme');if(s&&modes.indexOf(s)>=0)i=modes.indexOf(s);}catch(e){}
  function apply(){var m=modes[i];if(m==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',m);b.textContent='Theme: '+m;}
  apply();
  b.addEventListener('click',function(){i=(i+1)%modes.length;apply();try{localStorage.setItem('r4-theme',modes[i]);}catch(e){}});
})();
</script>
</body>
</html>
`;

writeFileSync(join(root, 'index.html'), html);
console.log('wrote index.html', html.length, 'bytes');
