// Round 5 naming board: big names of time, space and foresight. Writes ../index.html and the
// symbol and app-icon SVGs under ../assets/<slug>/. Run: node build.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { symbol, appIcon } from './marks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const FINALISTS = [
  {
    slug: 'kythera',
    name: 'Kythera',
    rank: 'Recommended',
    say: 'kih-THEER-uh',
    origin: 'Greek: the island of the Antikythera mechanism',
    capability: 'Meshing every reality into one model',
    story:
      'In 1901 sponge divers off Antikythera, the small Greek island beside Kythera, found a bronze box of meshing gears built more than 2,000 years ago. The Antikythera mechanism is the first known computer: turn the handle and it shows where the sun, moon and planets were on any past date and where they will be on any future one, with eclipses predicted years ahead. That is this product: separate realities (model, cloud, map, video) meshed into one machine you can wind backwards and forwards through time.',
    names: ['Fusion of every capture', 'Past and future on one timeline', 'Prediction from history'],
    taglines: ['Every reality, in mesh.', 'Wind back. Wind forward.', 'Past, present, predicted.'],
    mark: 'Meshing gears. The fine-toothed main wheel of the mechanism with its pointer, and a small bronze gear meshing on its rim: two realities turning as one. It reads as a dial and as precision engineering, which suits industrial buyers.',
    c: { ground: '#0E1716', inkD: '#ECEFEC', accD: '#D29A5C', paper: '#EEF1EF', inkL: '#0E1716', accL: '#A2672A' },
    swatches: [
      ['Deep patina', '#0E1716', 'Ground, title bar'],
      ['Bronze', '#D29A5C', 'Accent: the mechanism'],
      ['Verdigris', '#4FA08C', 'Secondary, charts'],
      ['Marble', '#EEF1EF', 'Reports, light ground'],
      ['Sea slate', '#3D5552', 'Lines, quiet text'],
    ],
    font: { label: 'Tenor Sans, caps, wide tracking', css: "font-family:'Tenor Sans',sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.18em", scale: 0.74 },
    risk: 'low',
    screen: 'Kythera Biopharmaceuticals (bought by Allergan in 2015) and a healthcare-data company use the name, both outside our classes. No software, drone, geospatial or defence product was found.',
    domains: 'kythera.com, .ai, .io and getkythera.com are registered. kytherahq.com and kytheraapp.com are free.',
    weakness: 'People will spell it Kithera or Cythera at first. The story needs one line on the splash screen and in the deck.',
  },
  {
    slug: 'auspex',
    name: 'Auspex',
    rank: 'Runner-up',
    say: 'AW-speks',
    origin: 'Latin avis + specere: the one who watches birds',
    capability: 'Reading the future from what flies',
    story:
      'A Roman auspex marked out a quarter of the sky with a curved staff and read the flight of birds inside it to judge whether a venture would succeed. The word gave English auspices and auspicious. Here the birds are drones, the marked sky is the survey area, and the reading is what the asset will need next.',
    names: ['Drone capture', 'Inspection findings', 'What to fix next'],
    taglines: ['See what is coming.', 'Foresight from above.', 'Every flight, read.'],
    mark: 'The templum. The quarter of sky the augur marked out, with one bird (a drone) crossing it in the accent colour.',
    c: { ground: '#0B0F1A', inkD: '#EEF2F8', accD: '#7FD1FF', paper: '#F2F4F8', inkL: '#0B0F1A', accL: '#1F7FB8' },
    swatches: [
      ['Night sky', '#0B0F1A', 'Ground, title bar'],
      ['Sky signal', '#7FD1FF', 'Accent: the bird in flight'],
      ['Omen amber', '#F0A93B', 'Secondary, warnings'],
      ['Paper', '#F2F4F8', 'Reports, light ground'],
      ['Dusk', '#3A4766', 'Lines, quiet text'],
    ],
    font: { label: 'Archivo Expanded, 700, caps', css: "font-family:'Archivo',sans-serif;font-stretch:122%;font-weight:700;text-transform:uppercase;letter-spacing:.1em", scale: 0.8 },
    risk: 'medium',
    screen: 'Auspex Pharmaceuticals (bought by Teva for $3.5B) and Auspex Diagnostics (cancer diagnostics). Auspex Systems was a 1990s storage maker, now gone. No drone, geospatial or defence product was found.',
    domains: 'Every common form is registered: auspex .com, .ai and .io, plus getauspex, auspexhq and auspexapp .com. It would need a two-word domain or a new TLD.',
    weakness: 'No clean domain. The pharma history means a professional search is needed before spending.',
  },
  {
    slug: 'saros',
    name: 'Saros',
    rank: 'Finalist',
    say: 'SAIR-os',
    origin: 'Babylonian astronomy: the eclipse cycle',
    capability: 'Aligning survey dates and predicting change',
    story:
      'Eclipses repeat every 18 years and 11 days. Babylonian astronomers found the cycle by keeping records of past eclipses, then used it to predict future ones. The app does the same with an asset: it aligns surveys from different dates, shows what changed, and uses the record to say what comes next. An eclipse is also two bodies lining up exactly, which is what registering two captures looks like.',
    names: ['Compare dates', 'Change detection', 'Registration and alignment'],
    taglines: ['Every cycle, aligned.', 'Read the past. Predict the next.', 'Know what returns.'],
    mark: 'An eclipse. One body slides across another and leaves a bright crescent: alignment shown at the moment it happens.',
    c: { ground: '#0A0A10', inkD: '#ECEDF3', accD: '#F5C451', paper: '#F3F4F8', inkL: '#0A0A10', accL: '#B98A12' },
    swatches: [
      ['Umbra', '#0A0A10', 'Ground, title bar'],
      ['Corona', '#F5C451', 'Accent: the crescent'],
      ['Ice', '#DCE3F2', 'Secondary, the second date'],
      ['Paper', '#F3F4F8', 'Reports, light ground'],
      ['Penumbra', '#3C3F52', 'Lines, quiet text'],
    ],
    font: { label: 'Michroma, caps', css: "font-family:'Michroma',sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:.1em", scale: 0.68 },
    risk: 'medium',
    screen: 'Saros is a Sony PlayStation 5 game by Housemarque, released in April 2026 and heavily marketed, and Roborock sells Saros robot vacuums. Nothing in software for industry, drones, geospatial or defence.',
    domains: 'saros.com, .ai, .io and getsaros.com are registered. saroshq.com and sarosapp.com are free.',
    weakness: 'For a few years, searches for Saros will return the Sony game first.',
  },
  {
    slug: 'zurvan',
    name: 'Zurvan',
    rank: 'Finalist',
    say: 'ZUR-vahn',
    origin: 'Ancient Persian: the god of infinite time and space',
    capability: 'All of time and all of space, in one place',
    story:
      'In ancient Persian belief, Zurvan is infinite time and infinite space together: the source from which everything else unfolds. No other name on either board says time and space so directly. It is hard, rare and sounds like nothing else in software.',
    names: ['The 4D scene', 'Every date of every asset', 'One place for everything'],
    taglines: ['All of time. All of space.', 'Every moment of every asset.', 'Infinite time, one place.'],
    mark: 'A spiral. Time unwinding outward from one moment, with the first and the latest moment in the accent colour.',
    c: { ground: '#120F1A', inkD: '#F0ECF6', accD: '#FF7A45', paper: '#F5F2F8', inkL: '#120F1A', accL: '#D9541C' },
    swatches: [
      ['Void', '#120F1A', 'Ground, title bar'],
      ['Ember', '#FF7A45', 'Accent: first and latest moment'],
      ['Nebula', '#8E7CC3', 'Secondary, charts'],
      ['Paper', '#F5F2F8', 'Reports, light ground'],
      ['Ash', '#4A4458', 'Lines, quiet text'],
    ],
    font: { label: 'Unbounded, 600, caps', css: "font-family:'Unbounded',sans-serif;font-weight:600;text-transform:uppercase;letter-spacing:.06em", scale: 0.72 },
    risk: 'low',
    screen: 'One filing: Maison Zurvan Pty Ltd (Australia, 2025) for watches, eyewear and some software. No drone, geospatial, AI or defence use was found.',
    domains: 'zurvan.com, .ai and .io are registered. getzurvan.com, zurvanhq.com and zurvanapp.com are free.',
    weakness: 'Almost nobody knows the word. It is Persian, which some government buyers may read with a political lens. Check with the sales team.',
  },
  {
    slug: 'eidolon',
    name: 'Eidolon',
    rank: 'Finalist',
    say: 'eye-DOH-lon',
    origin: 'Greek: the image, the perfect double',
    capability: 'The digital twin',
    story:
      'In Greek myth the gods sent an eidolon of Helen to Troy: a double so exact that two armies fought ten years over it. The app builds the double of a real asset from drone captures, keeps every version of it, and lets you inspect the twin instead of climbing the real thing.',
    names: ['Digital twin', 'Reality capture', 'Every version kept'],
    taglines: ['The twin that remembers.', 'Every asset, and its double.', 'Reality, mirrored.'],
    mark: 'The block and its double. A solid block with its phantom twin drawn in outline behind it, in the accent colour.',
    c: { ground: '#0D0C14', inkD: '#EEEDF6', accD: '#A78BFA', paper: '#F4F3F9', inkL: '#0D0C14', accL: '#6D4FD6' },
    swatches: [
      ['Obsidian', '#0D0C14', 'Ground, title bar'],
      ['Phantom', '#A78BFA', 'Accent: the twin'],
      ['Mist', '#B9C4D6', 'Secondary, selection'],
      ['Paper', '#F4F3F9', 'Reports, light ground'],
      ['Graphite', '#45435A', 'Lines, quiet text'],
    ],
    font: { label: 'Bricolage Grotesque, 600, caps', css: "font-family:'Bricolage Grotesque',sans-serif;font-weight:600;font-variation-settings:'opsz' 96;text-transform:uppercase;letter-spacing:.08em", scale: 0.74 },
    risk: 'medium',
    screen: 'Eidolon is an open-source AI agent server for companies, plus a few games and a venture fund. Nothing in drones, geospatial or inspection.',
    domains: 'eidolon.com, .ai, .io and geteidolon.com are registered. eidolonhq.com and eidolonapp.com are free.',
    weakness: 'Hard to spell after hearing it. "Phantom" can sound unreal for a tool that has to prove evidence.',
  },
  {
    slug: 'calchas',
    name: 'Calchas',
    rank: 'Finalist',
    say: 'KAL-kus',
    origin: 'Homer, Iliad: the seer of the Greek fleet',
    capability: 'Past, present and future of an asset',
    story:
      'Homer says Calchas "knew the things that were, the things to come, and the things that had been before". He was the seer the Greek fleet relied on at Troy. It is the plainest statement of what this app does: show an asset as it was, as it is, and as it is heading.',
    names: ['History of every survey', 'Today\'s condition', 'Forecast and change'],
    taglines: ['What was. What is. What will be.', 'Foresight for every asset.', 'Know the whole story.'],
    mark: 'Two cones meeting at now. The past cone above in outline, the future cone below in solid, and the present as a ring in the accent colour. It also reads as an hourglass and as a camera view cone.',
    c: { ground: '#140B0E', inkD: '#F4ECEE', accD: '#FF5C6C', paper: '#F7F2F3', inkL: '#140B0E', accL: '#D0293C' },
    swatches: [
      ['Oxblood night', '#140B0E', 'Ground, title bar'],
      ['Signal crimson', '#FF5C6C', 'Accent: the present'],
      ['Bone', '#E9DCCB', 'Secondary, highlights'],
      ['Paper', '#F7F2F3', 'Reports, light ground'],
      ['Iron', '#55474B', 'Lines, quiet text'],
    ],
    font: { label: 'Big Shoulders Display, 800, caps', css: "font-family:'Big Shoulders Display',sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:.08em", scale: 1.05 },
    risk: 'low',
    screen: 'Nothing found in software, AI, drones, geospatial or defence. It is the cleanest name in this round.',
    domains: 'calchas.com, .ai and .io are registered. getcalchas.com, calchashq.com and calchasapp.com are free.',
    weakness: 'The sound is awkward (KAL-kus), and in the myth he also demanded the sacrifice of Iphigenia.',
  },
];

// where the names came from
const FAMILIES = [
  { title: 'Seers and omens', body: 'People who read the past to see the future.', names: ['Auspex', 'Calchas', 'Augur', 'Tiresias', 'Pythia', 'Sibyl', 'Specula', 'Horasis'] },
  { title: 'Gods of time and space', body: 'Time itself, the fates, the record of everything.', names: ['Zurvan', 'Janus', 'Aion', 'Norn', 'Thoth', 'Akasha', 'Phoebe', 'Hora'] },
  { title: 'Machines and cycles of the sky', body: 'Instruments that compute past and future.', names: ['Kythera', 'Saros', 'Antikythera', 'Aether'] },
  { title: 'Spacetime and the double', body: 'Physics of time and space, and the twin.', names: ['Eidolon', 'Lightcone', 'Manifold', 'Parallax', 'Continuum', 'Epoch', 'Aeon', 'Topos', 'Vigil', 'Aleph'] },
];

const LONGLIST = [
  ['Kythera', 'Machines', 'Island of the Antikythera mechanism', 'low', 'Kythera Biopharmaceuticals (Allergan); healthcare data', 'Finalist'],
  ['Auspex', 'Seers', 'Roman bird-watcher who read the future', 'medium', 'Auspex Pharmaceuticals (Teva), Auspex Diagnostics', 'Finalist'],
  ['Saros', 'Machines', 'The eclipse cycle', 'medium', 'Sony/Housemarque PS5 game (2026); Roborock vacuums', 'Finalist'],
  ['Zurvan', 'Gods', 'Persian god of infinite time and space', 'low', 'Maison Zurvan Pty Ltd filing (watches, some software)', 'Finalist'],
  ['Eidolon', 'Spacetime', 'The perfect double', 'medium', 'Eidolon open-source AI agent server', 'Finalist'],
  ['Calchas', 'Seers', 'Seer of what was, is and will be', 'low', 'None found', 'Finalist'],
  ['Horasis', 'Seers', 'Greek for vision', 'medium', 'Horasis, a global business forum (events, not software)', 'Reserve'],
  ['Tiresias', 'Seers', 'Blind prophet of past and future', 'medium', 'Tiresias and Teiresias AI and risk-software startups', 'Reserve'],
  ['Specula', 'Seers', 'Latin for watchtower', 'medium', 'Speculum AI near; reads as the medical speculum', 'Reserve'],
  ['Antikythera', 'Machines', 'The first analogue computer', 'medium', 'Antikythera programme (Berggruen AI think tank); hard to spell', 'Dropped: long'],
  ['Janus', 'Gods', 'God facing past and future', 'high', 'JANUS NGA geospatial-intelligence programme; DeepSeek Janus AI models', 'Dropped: collision'],
  ['Aion', 'Gods', 'God of the ages', 'high', 'AION Robotics (autonomous inspection drones and robots)', 'Dropped: collision'],
  ['Norn', 'Gods', 'Norse fates of past, present and future', 'high', 'Norn.ai (decision-intelligence AI for governments)', 'Dropped: collision'],
  ['Thoth', 'Gods', 'Egyptian god of records and reckoning', 'high', 'Thoth AI (3D point-cloud labelling)', 'Dropped: collision'],
  ['Akasha', 'Gods', 'Ether; the record of all events', 'medium', 'Many small users; New Age tone', 'Dropped: tone'],
  ['Phoebe', 'Gods', 'Titaness of prophecy', 'medium', 'Phoebe AI-agent platform (GV-backed, 2025)', 'Dropped: soft'],
  ['Hora', 'Gods', 'Goddess of the hours', 'medium', 'Close to Horus drone-inspection firms', 'Dropped: crowded'],
  ['Augur', 'Seers', 'Roman reader of omens', 'high', 'Augur defence AI startup by ex-Palantir engineers (2026)', 'Dropped: collision'],
  ['Pythia', 'Seers', 'The Oracle of Delphi', 'high', 'EU defence foresight tool PYTHIA; Pythia LLM suite', 'Dropped: collision'],
  ['Sibyl', 'Seers', 'Prophetess', 'high', 'Sibyl GEOINT satellite-tasking app; Psycho-Pass "Sibyl System"', 'Dropped: collision'],
  ['Aether', 'Machines', 'The upper sky', 'high', 'Aether Global Innovations (drone management for utilities)', 'Dropped: collision'],
  ['Lightcone', 'Spacetime', 'Past and future light cones', 'high', 'Tzafon Lightcone AI agent; YC Lightcone podcast', 'Dropped: collision'],
  ['Manifold', 'Spacetime', 'A shaped space', 'high', 'DJI Manifold onboard computer; Manifold GIS', 'Dropped: collision'],
  ['Parallax', 'Spacetime', 'Seeing from two positions', 'high', 'ParallaxOS drone-defence C2; Parallax Worlds digital twins', 'Dropped: collision'],
  ['Continuum', 'Spacetime', 'Unbroken time and space', 'high', 'Continuum Industries (geospatial AI for utilities)', 'Dropped: collision'],
  ['Epoch', 'Spacetime', 'A moment in time; survey epoch', 'high', 'Epoch AI; Epoch Solutions (utility GIS)', 'Dropped: collision'],
  ['Aeon', 'Spacetime', 'An age', 'high', 'Aeon (missiles and ODIN targeting software)', 'Dropped: collision'],
  ['Topos', 'Spacetime', 'Greek for place', 'medium', 'Topos AI, Topos Labs, TOPODRONE', 'Dropped: crowded'],
  ['Vigil', 'Spacetime', 'Watchfulness', 'high', 'Vigil Autonomy and VigilAir (counter-drone)', 'Dropped: collision'],
  ['Aleph', 'Spacetime', 'Borges: the point containing all points', 'high', 'Aleph Alpha (sovereign AI)', 'Dropped: collision'],
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
      <div class="rep-title">Asset review</div>
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

const status = Object.fromEntries(LONGLIST.map((r) => [r[0], r[5] === 'Finalist' ? 'fin' : r[5] === 'Reserve' ? 'res' : 'out']));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Naming Round 5</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Michroma&family=Red+Hat+Display:wght@400..800&family=Saira+Semi+Condensed:wght@500;600;700&family=Unbounded:wght@400..700&family=Tenor+Sans&family=Big+Shoulders+Display:wght@700;800&display=swap">
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
.fam li.res{color:var(--fg-1);border-color:var(--line)}
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
<header class="top"><div class="wrap"><span class="eyebrow">Synapse Solutions · Brand · Round 5 · 7 Oct 2026</span><button class="theme-btn" id="theme-btn" type="button">Theme: auto</button></div></header>
<main class="wrap">
<section>
  <h1>Big names for seeing across time and space</h1>
  <p class="lede">You asked for names with the weight of Palantir, Lattice and Maven: gods, seers and big ideas about time and space, looking into the past and the future, because the product meshes many realities into one. 30 names were screened. Most of the famous ones are already taken in our own field, so the six that survive are the ones you could actually own.</p>
  <p class="note">This is a quick screen, not legal clearance. Collisions were checked with web searches on 7 Oct 2026, and domains with live RDAP queries to the .com, .ai and .io registries. No trademark register was searched. Counsel must clear the pick in classes 9 and 42 before anything is bought or printed.</p>
  <div class="strip">${FINALISTS.map((F) => `<a href="#${F.slug}" style="background:${F.c.ground};color:${F.c.inkD}">${appIcon(F.slug, { ground: F.c.ground, ink: F.c.inkD, acc: F.c.accD }, 56)}<span class="s-name">${esc(F.name)}</span><span class="s-cap">${esc(F.capability)}</span></a>`).join('')}</div>
  <nav class="toc"><a href="#recommendation">Recommendation</a><a href="#capabilities">Where the names came from</a>${FINALISTS.map((F) => `<a href="#${F.slug}">${esc(F.name)}</a>`).join('')}<a href="#longlist">Longlist</a><a href="#method">Method</a></nav>
</section>

<section id="recommendation">
  <h2>Recommendation: Kythera, with the Meshing Gears mark</h2>
  <div class="rec">
    <div class="rec-visual" style="background:${FINALISTS[0].c.ground}">${lockup(FINALISTS[0], FINALISTS[0].c.inkD, FINALISTS[0].c.accD, 56)}</div>
    <div>
      <ul>
        <li><strong>It has the best story for this product.</strong> The Antikythera mechanism meshed separate cycles into one machine that showed the sky on any past or future date. That is what the app does with model, cloud, map and video.</li>
        <li><strong>It sounds big.</strong> Three syllables, Greek, soft at the start and hard in the middle. It sits beside Palantir without copying it.</li>
        <li><strong>It is clean where it matters.</strong> The only holders found are in pharma and healthcare data. kytherahq.com and kytheraapp.com are free.</li>
        <li><strong>The mark is ownable.</strong> Meshing gears say precision engineering and fusion at once, and nothing in the drone or GIS field uses them.</li>
      </ul>
      <p class="note" style="margin-top:12px">If you want the strongest drone story, take <strong>Auspex</strong> (the Roman who read the future from birds in a marked patch of sky), but it has no clean domain. If you want the name that says time and space most directly, take <strong>Zurvan</strong>. <strong>Calchas</strong> is the cleanest name in the round.</p>
    </div>
  </div>
</section>

<section id="capabilities">
  <h2>Where the names came from</h2>
  <p>30 names from four families. Finalists are highlighted, reserves are plain, and struck names failed the screen because someone in drones, geospatial, defence or AI already uses them.</p>
  <div class="fam">${FAMILIES.map((g) => `<div><h3>${esc(g.title)}</h3><p>${esc(g.body)}</p><ul>${g.names.map((n) => `<li class="${status[n] || 'out'}">${esc(n)}</li>`).join('')}</ul></div>`).join('')}</div>
</section>

${FINALISTS.map(finalist).join('\n')}

<section id="longlist">
  <h2>Longlist: 30 names screened</h2>
  <p>Risk is HIGH when a holder works in our field (drones, geospatial, inspection, digital twins, defence) or is a famous brand.</p>
  <div class="tbl"><table>
    <thead><tr><th>Name</th><th>Group</th><th>Idea</th><th>Risk</th><th>Strongest collision found</th><th>Verdict</th></tr></thead>
    <tbody>${LONGLIST.map(([n, g, idea, r, col, v]) => `<tr class="${v === 'Finalist' ? 'is-fin' : ''}"><td>${esc(n)}</td><td>${esc(g)}</td><td>${esc(idea)}</td><td>${riskChip(r)}</td><td>${esc(col)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody>
  </table></div>
</section>

<section id="method">
  <h2>Method and limits</h2>
  <ul class="plain">
    <li>Names came from myth, astronomy and physics about time, space and foresight. Every name from rounds 1 to 4 was excluded, as were Tolkien names (Palantir and Anduril already took them).</li>
    <li>Each name had two or three web searches against software, AI (including model names), drones, geospatial, reality capture, oil and gas and defence. The search engine is US-centred and recall is thin, so "none found" does not mean clear.</li>
    <li>Domains were checked live with RDAP on 7 Oct 2026 (Verisign for .com, Identity Digital for .ai and .io). Every bare .com is registered. Raw results are in rdap-results.txt.</li>
    <li>Marks are hand-placed SVG on a 64-unit grid and each works in one colour. Wordmarks are set in Google Fonts for this board. The chosen one would be redrawn as outlines.</li>
    <li>Next steps: you pick one; counsel clears it in classes 9 and 42 in the US, EU and GCC; we secure the domain and handles; then packages/brand is updated. Stratlas stays the working name until then.</li>
  </ul>
  <p class="note">Files: assets/&lt;name&gt;/symbol-dark.svg, symbol-light.svg, symbol-mono.svg and appicon.svg (1024 px) · build/build.mjs and build/marks.mjs regenerate this page.</p>
</section>
</main>
<footer><div class="wrap">Synapse Solutions · Round 5 naming board · quick screen, not legal clearance · all scene and report content is synthetic.</div></footer>
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
