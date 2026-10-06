// The change and modelling demo site (build-change-demo.mjs): a small fictional plant in open
// desert, surveyed on two dates with known differences. Everything is procedural and seeded; no
// part of it comes from a real site or survey. Every difference listed here is written to the
// project's truth.json, so tests can assert exact counts.
//
// Local frame (data-conventions section 1): metres, Y up, X east, Z south.

import { Part, box, cone, cylinder, decal, onPipe, onPlane, onShell } from './geometry.mjs';
import { fbm, mix, prng, rgb, smoothstep } from './noise.mjs';
import { Renderer } from './render.mjs';
import { SUN, sandAt, sandTextures } from './scene.mjs';

/** Fictional location: open desert, about 20 km from the tank farm demo and far from any survey. */
export const LOCATION = { lat: 23.2731, lon: 1.0614, h: 392, epsg: 32631 };
export const CAPTURES = [
  { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
  { id: 'd2', label: 'Survey 13 April 2026', date: '2026-04-13' },
];
/** The surveyed square (orthos, DSMs, clouds). */
export const AREA = { x0: -48, z0: -48, x1: 48, z1: 48 };

// ------------------------------------------------------------------ objects per date

/** Vertical tanks: centre, radius, shell height, cone roof rise. */
export const TANKS = [
  { tag: 'T-201', cx: -26, cz: -18, R: 6, H: 9, rise: 1.2 },
  { tag: 'T-202', cx: -8, cz: -20, R: 5, H: 8, rise: 1 },
  { tag: 'T-203', cx: 10, cz: -22, R: 4, H: 7, rise: 0.8 },
];
/** The dent on T-202 that the later date shows (inward, known depth). */
export const DENT = { tag: 'T-202', theta: Math.PI / 2 + 0.3, y: 3, radius: 1.2, depth: 0.15 };

/** Boxes: centre of the base, size [x, y, z]; `dates` the captures they exist on. */
export const BOXES = [
  {
    tag: 'B-01',
    name: 'Control building',
    kind: 'building',
    c: [-28, 0, 24],
    size: [12, 4.5, 8],
    dates: ['d1', 'd2'],
  },
  {
    tag: 'C-01',
    name: 'Container C-01',
    kind: 'container',
    c: [6, 0, 20],
    size: [6.06, 2.59, 2.44],
    dates: ['d1'],
  },
  {
    tag: 'C-02',
    name: 'Container C-02',
    kind: 'container',
    c: [14, 0, 20],
    size: [6.06, 2.59, 2.44],
    dates: ['d1', 'd2'],
  },
  {
    tag: 'SK-01',
    name: 'Pump skid SK-01',
    kind: 'skid',
    c: [28, 0, 0],
    size: [4, 2.2, 3],
    dates: ['d1', 'd2'],
    moved: [3, 0, -1.5],
  },
  {
    tag: 'S-01',
    name: 'Shelter S-01',
    kind: 'shelter',
    c: [-6, 0, 32],
    size: [8, 3, 6],
    dates: ['d2'],
  },
];
export const PIPE = { tag: 'P-01', a: [-20, 1.5, -6], b: [24, 1.5, -6], r: 0.3, supports: 6 };

/** A box on a date (centre moved on the later date), or null when it is not there. */
export function boxOn(b, date) {
  if (!b.dates.includes(date)) return null;
  const c = date === 'd2' && b.moved ? b.c.map((v, i) => v + b.moved[i]) : b.c;
  return { ...b, c };
}

// ------------------------------------------------------------------ terrain

/** Stockpile PL-01 (grows) and excavation EX-01 (dug before the later date). */
export const PILE = { tag: 'PL-01', cx: 32, cz: 26, d1: { h: 3, r: 7 }, d2: { h: 3.6, r: 7.8 } };
export const PIT = { tag: 'EX-01', x0: 31, x1: 37, z0: -32, z1: -28, depth: 1.5, dates: ['d2'] };

function pileHeight(x, z, date) {
  const p = PILE[date];
  const d = Math.hypot(x - PILE.cx, z - PILE.cz);
  if (d >= p.r) return 0;
  const t = 1 - d / p.r;
  // a rounded crest over angle-of-repose sides
  return p.h * smoothstep(0, 1, Math.min(1, t * 1.6)) ** 0.9;
}

function pitDepth(x, z, date) {
  if (!PIT.dates.includes(date)) return 0;
  const inside = Math.min(x - PIT.x0, PIT.x1 - x, z - PIT.z0, PIT.z1 - z);
  return inside <= 0 ? 0 : Math.min(PIT.depth, inside);
}

/** Bare-earth height (local y) on a date: flat desert, the pile and the pit. */
export function terrainHeight(x, z, date) {
  return pileHeight(x, z, date) - pitDepth(x, z, date);
}

// ------------------------------------------------------------------ ground features

/** Survey markers: magenta squares painted on the ground (the ONNX test detector finds them). */
export const MARKER_SIZE = 0.8;
export const MARKERS = [
  { id: 'M1', x: -14, z: 9, dates: ['d1', 'd2'] },
  { id: 'M2', x: 21, z: 10, dates: ['d1'] },
  { id: 'M3', x: -38, z: -4, dates: ['d1', 'd2'] },
  { id: 'M4', x: 2, z: 8, dates: ['d2'] },
];
/** sRGB of the marker paint (the detector's colour, onnx-test-model.mjs MARKER_RGB). */
const MARKER = rgb(224, 32, 224);

/** Map vector features per date (ids stable across dates). Coordinates local [x, z]. */
export const VECTORS = {
  d1: [
    {
      id: 'F-01',
      kind: 'fence',
      line: [
        [40, -44],
        [40, 0],
        [40, 44],
      ],
      props: { name: 'East fence', type: 'fence' },
    },
    {
      id: 'TR-01',
      kind: 'track',
      line: [
        [-44, 4],
        [40, 4],
      ],
      props: { name: 'Main track', type: 'track' },
    },
    {
      id: 'PD-01',
      kind: 'pad',
      ring: [
        [2, 16],
        [20, 16],
        [20, 24],
        [2, 24],
      ],
      props: { name: 'Container pad', type: 'pad', surface: 'gravel' },
    },
    {
      id: 'DR-01',
      kind: 'drain',
      line: [
        [-44, 40],
        [0, 40],
      ],
      props: { name: 'Drain', type: 'drain' },
    },
  ],
  d2: [
    {
      id: 'F-01',
      kind: 'fence',
      line: [
        [40, -44],
        [44, -24],
        [44, -12],
        [40, 0],
        [40, 44],
      ],
      props: { name: 'East fence', type: 'fence' },
    },
    {
      id: 'TR-01',
      kind: 'track',
      line: [
        [-44, 4],
        [40, 4],
      ],
      props: { name: 'Main track', type: 'track' },
    },
    {
      id: 'TR-02',
      kind: 'track',
      line: [
        [30, 4],
        [34, -26],
      ],
      props: { name: 'Track to the excavation', type: 'track' },
    },
    {
      id: 'PD-01',
      kind: 'pad',
      ring: [
        [2, 16],
        [20, 16],
        [20, 24],
        [2, 24],
      ],
      props: { name: 'Container pad', type: 'pad', surface: 'concrete' },
    },
    {
      id: 'DR-01',
      kind: 'drain',
      line: [
        [-44, 40],
        [0, 40],
      ],
      props: { name: 'Drain', type: 'drain' },
    },
  ],
};

/** A cloud shadow on the later date over open ground: lighting only, must not count as change. */
export const SHADOW = { cx: -20, cz: -2, rx: 9, rz: 5, factor: 0.6 };
/** Global colour shift of the later date (sun, season): must not count as change either. */
export const TINT = [1.04, 1, 0.95];

const segDist = (x, z, a, b) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
};

const TRACK = rgb(198, 182, 150);
const GRAVEL = rgb(168, 160, 148);
const PILE_COL = rgb(150, 136, 118);
const PIT_COL = rgb(150, 116, 80);

/** Ground albedo on a date (sand, tracks, the pad, pile, pit, markers, the shadow patch). */
export function groundColour(sand, date, seed) {
  const tracks = VECTORS[date].filter((v) => v.kind === 'track');
  const pad = VECTORS[date].find((v) => v.id === 'PD-01').ring;
  const markers = MARKERS.filter((m) => m.dates.includes(date));
  return (x, z, foot, out) => {
    sandAt(sand, x, z, foot, out);
    let c = [out[0], out[1], out[2]];
    for (const t of tracks) {
      const d = segDist(x, z, t.line[0], t.line[1]);
      if (d < 2.2)
        c = mix(
          c,
          TRACK.map((v) => v * (0.94 + 0.08 * fbm(x * 0.7, z * 0.7, seed + 9, 2))),
          smoothstep(2.2, 1.6, d),
        );
    }
    if (x >= pad[0][0] && x <= pad[1][0] && z >= pad[0][1] && z <= pad[2][1])
      c = GRAVEL.map((v) => v * (0.95 + 0.1 * fbm(x * 2, z * 2, seed + 11, 2)));
    const ph = pileHeight(x, z, date);
    if (ph > 0.02) c = mix(c, PILE_COL, smoothstep(0.02, 0.4, ph));
    const pd = pitDepth(x, z, date);
    if (pd > 0) c = mix(c, PIT_COL, smoothstep(0, 0.3, pd));
    for (const m of markers)
      if (Math.abs(x - m.x) <= MARKER_SIZE / 2 && Math.abs(z - m.z) <= MARKER_SIZE / 2) c = MARKER;
    if (date === 'd2') {
      const e = ((x - SHADOW.cx) / SHADOW.rx) ** 2 + ((z - SHADOW.cz) / SHADOW.rz) ** 2;
      if (e < 1.3) {
        const k = 1 - (1 - SHADOW.factor) * smoothstep(1.3, 0.8, e);
        c = c.map((v) => v * k);
      }
    }
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  };
}

// ------------------------------------------------------------------ issues (painted on the parts)

/**
 * The defects on each date. `track` links the same defect across dates (truth only: the files do
 * not carry it, so the change comparison has to find the match). Area in m2.
 */
export const DEFECTS = [
  {
    track: 'K1',
    date: 'd1',
    code: 'F01',
    classId: 'corrosion',
    severity: 2,
    part: 'T-201',
    theta: Math.PI / 2 - 0.2,
    y: 3,
    area: 0.6,
    title: 'Corrosion on the T-201 shell',
  },
  {
    track: 'K2',
    date: 'd1',
    code: 'F02',
    classId: 'damage',
    severity: 1,
    part: 'T-203',
    theta: Math.atan2(14, 6),
    y: 2.5,
    area: 0.4,
    title: 'Coating damage on T-203',
  },
  {
    track: 'K3',
    date: 'd1',
    code: 'F03',
    classId: 'damage',
    severity: 2,
    part: 'B-01',
    wall: 'south',
    u: 1.5,
    y: 2,
    area: 0.8,
    title: 'Spalling on the south wall of B-01',
  },
  {
    track: 'K4',
    date: 'd1',
    code: 'F04',
    classId: 'corrosion',
    severity: 1,
    part: 'P-01',
    along: 0.55,
    area: 0.15,
    title: 'Corrosion on pipe P-01',
  },
  {
    track: 'K5',
    date: 'd1',
    code: 'F05',
    classId: 'other',
    severity: 1,
    part: 'ground',
    x: 12,
    z: 25,
    area: 1,
    title: 'Oil stain by container C-02',
  },
  // later date: K2 repaired (gone), K3 grown by half, K6 new (the dent)
  {
    track: 'K1',
    date: 'd2',
    code: 'F11',
    classId: 'corrosion',
    severity: 2,
    part: 'T-201',
    theta: Math.PI / 2 - 0.2,
    y: 3,
    area: 0.6,
    title: 'Corrosion on the T-201 shell',
  },
  {
    track: 'K3',
    date: 'd2',
    code: 'F13',
    classId: 'damage',
    severity: 2,
    part: 'B-01',
    wall: 'south',
    u: 1.5,
    y: 2,
    area: 1.2,
    title: 'Spalling on the south wall of B-01',
  },
  {
    track: 'K4',
    date: 'd2',
    code: 'F14',
    classId: 'corrosion',
    severity: 1,
    part: 'P-01',
    along: 0.55,
    area: 0.15,
    title: 'Corrosion on pipe P-01',
  },
  {
    track: 'K5',
    date: 'd2',
    code: 'F15',
    classId: 'other',
    severity: 1,
    part: 'ground',
    x: 12,
    z: 25,
    area: 1,
    title: 'Oil stain by container C-02',
  },
  {
    track: 'K6',
    date: 'd2',
    code: 'F16',
    classId: 'damage',
    severity: 2,
    part: 'T-202',
    theta: DENT.theta,
    y: DENT.y,
    area: Math.PI * DENT.radius ** 2,
    title: 'Dent in the T-202 shell',
    dent: true,
  },
];

/** Surface mapping of a defect: { at(u, v), normalAt(u, v), centre, normal }. */
export function defectMapping(d) {
  if (d.part.startsWith('T-')) {
    const t = TANKS.find((k) => k.tag === d.part);
    return onShell(t.cx, t.cz, t.R, d.theta, d.y);
  }
  if (d.part === 'B-01') {
    const b = BOXES.find((k) => k.tag === 'B-01');
    return onPlane([b.c[0] + d.u, d.y, b.c[2] + b.size[2] / 2], [1, 0, 0], [0, 1, 0]);
  }
  if (d.part === 'P-01') return onPipe(PIPE.a, PIPE.b, PIPE.r, d.along, Math.PI / 2 + 0.4);
  return onPlane([d.x, 0, d.z], [1, 0, 0], [0, 0, -1]);
}

// ------------------------------------------------------------------ the model

const STEEL = rgb(186, 190, 194);
const STEEL_DARK = rgb(92, 102, 116);
const RUST = rgb(128, 66, 36);
const COATING = rgb(232, 228, 214);
const CONCRETE = rgb(188, 186, 180);
const CONTAINER = rgb(52, 92, 140);
const SKID = rgb(214, 160, 40);
const SHELTER = rgb(150, 150, 140);
const STAIN = rgb(60, 52, 44);

/** A tank shell with a smooth dent (inward, `dent` or none) at the given angle and height. */
function shell(part, t, dent) {
  const segs = 96;
  const rows = 36;
  const ids = [];
  for (let j = 0; j <= rows; j++) {
    const y = (t.H * j) / rows;
    const row = [];
    for (let k = 0; k <= segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      let r = t.R;
      if (dent) {
        let da = a - dent.theta;
        da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
        const d = Math.hypot(da * t.R, y - dent.y);
        if (d < dent.radius) r -= dent.depth * (1 - (d / dent.radius) ** 2) ** 2;
      }
      row.push(
        part.v(
          [t.cx + Math.cos(a) * r, y, t.cz + Math.sin(a) * r],
          [Math.cos(a), 0, Math.sin(a)],
          STEEL,
        ),
      );
    }
    ids.push(row);
  }
  for (let j = 0; j < rows; j++)
    for (let k = 0; k < segs; k++) {
      part.tri(ids[j][k], ids[j + 1][k + 1], ids[j + 1][k]);
      part.tri(ids[j][k], ids[j][k + 1], ids[j + 1][k + 1]);
    }
}

const ring = (area) => {
  const r = Math.sqrt(area / Math.PI);
  return new Array(18).fill(r);
};

/** The tagged parts of the model on a date (each a glTF node named by its tag). */
export function buildParts(date) {
  const parts = [];
  const defects = DEFECTS.filter((d) => d.date === date && !d.dent && d.part !== 'ground');
  const paint = (part, tag) => {
    for (const d of defects.filter((x) => x.part === tag)) {
      const m = defectMapping(d);
      decal(
        part,
        m.at,
        m.normalAt,
        ring(d.area),
        d.classId === 'corrosion' ? RUST : COATING,
        0.015,
      );
    }
  };
  for (const t of TANKS) {
    const p = new Part(t.tag, t.tag, 'Tank area');
    shell(p, t, date === 'd2' && t.tag === DENT.tag ? DENT : null);
    cone(p, [t.cx, t.H, t.cz], t.R + 0.05, t.rise, 96, STEEL_DARK);
    paint(p, t.tag);
    parts.push(p);
  }
  for (const b0 of BOXES) {
    const b = boxOn(b0, date);
    if (!b) continue;
    const col = { building: CONCRETE, container: CONTAINER, skid: SKID, shelter: SHELTER }[b.kind];
    const p = new Part(b.tag, b.tag, b.kind === 'building' ? 'Buildings' : 'Yard');
    box(p, [b.c[0], b.size[1] / 2, b.c[2]], b.size, col);
    paint(p, b.tag);
    parts.push(p);
  }
  {
    const p = new Part(PIPE.tag, PIPE.tag, 'Pipes');
    cylinder(p, PIPE.a, PIPE.b, PIPE.r, 24, STEEL_DARK, { caps: true });
    const len = PIPE.b[0] - PIPE.a[0];
    for (let k = 0; k <= PIPE.supports; k++) {
      const x = PIPE.a[0] + (len * k) / PIPE.supports;
      box(p, [x, (PIPE.a[1] - PIPE.r) / 2, PIPE.a[2]], [0.3, PIPE.a[1] - PIPE.r, 0.6], CONCRETE);
    }
    paint(p, PIPE.tag);
    parts.push(p);
  }
  {
    // ground stains are part of the model too (a decal on a flat patch), so photos show them
    const stains = DEFECTS.filter((d) => d.date === date && d.part === 'ground');
    if (stains.length) {
      const p = new Part('GND-01', 'GND-01', 'Yard');
      for (const d of stains) {
        const m = defectMapping(d);
        decal(p, m.at, () => [0, 1, 0], ring(d.area), STAIN, 0.01);
      }
      parts.push(p);
    }
  }
  return parts;
}

// ------------------------------------------------------------------ ground meshes and the world

function heightField(x0, z0, x1, z1, cell, date) {
  const nx = Math.round((x1 - x0) / cell);
  const nz = Math.round((z1 - z0) / cell);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const nrm = new Float32Array(pos.length);
  const H = (x, z) => terrainHeight(x, z, date);
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = x0 + i * cell;
      const z = z0 + j * cell;
      const o = (j * (nx + 1) + i) * 3;
      pos[o] = x;
      pos[o + 1] = H(x, z);
      pos[o + 2] = z;
      const e = cell;
      const a = H(x - e, z) - H(x + e, z);
      const b = H(x, z - e) - H(x, z + e);
      const l = Math.hypot(a, 2 * e, b);
      nrm[o] = a / l;
      nrm[o + 1] = (2 * e) / l;
      nrm[o + 2] = b / l;
    }
  const idx = new Uint32Array(nx * nz * 6);
  let k = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const c = a + nx + 1;
      idx.set([a, c, c + 1, a, c + 1, a + 1], k);
      k += 6;
    }
  return { pos, nrm, col: new Float32Array(pos.length), idx, ground: true, noShadow: false };
}

/** Patches of the terrain that are not flat (pile, pit), on a 1 m grid in whole metres. */
const RELIEF = [
  { x0: 22, z0: 16, x1: 42, z1: 36 },
  { x0: 30, z0: -34, x1: 38, z1: -26 },
];

/** Flat desert tiles around the relief patches, out to the horizon. */
function flatGround() {
  const pos = [];
  const idx = [];
  const quad = (x0, z0, x1, z1) => {
    const b = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
  };
  const inRelief = (x, z) => RELIEF.some((r) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1);
  for (let x = -64; x < 64; x += 2)
    for (let z = -64; z < 64; z += 2) if (!inRelief(x + 1, z + 1)) quad(x, z, x + 2, z + 2);
  for (let x = -3008; x < 3008; x += 64)
    for (let z = -3008; z < 3008; z += 64) {
      if (x >= -64 && x + 64 <= 64 && z >= -64 && z + 64 <= 64) continue;
      quad(x, z, x + 64, z + 64);
    }
  const n = pos.length / 3;
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nrm[3 * i + 1] = 1;
  return {
    pos: new Float32Array(pos),
    nrm,
    col: new Float32Array(n * 3),
    idx: new Uint32Array(idx),
    ground: true,
    noShadow: true,
  };
}

/**
 * The renderable world of one date: the parts (tagged meshes), the ground and a renderer lit by the
 * demo sun. `sand` may be shared between dates (it takes a moment to make).
 */
export function changeWorld(seed, date, o = {}) {
  const sand = o.sand ?? sandTextures(seed);
  const parts = buildParts(date);
  const items = [
    ...parts.map((p) => p.arrays()),
    ...RELIEF.map((r) => heightField(r.x0, r.z0, r.x1, r.z1, 0.25, date)),
    flatGround(),
  ];
  const ground = groundColour(sand, date, seed);
  const renderer = new Renderer(items, {
    sun: SUN,
    ground,
    shadow: { x0: -60, z0: -60, x1: 60, z1: 60, size: 2048 },
  });
  return { sand, parts, renderer, ground, date };
}

/** The colour shift of the later date, applied to a rendered RGB image in place. */
export function applyTint(rgbBuf, date) {
  if (date !== 'd2') return rgbBuf;
  for (let i = 0; i < rgbBuf.length; i += 3)
    for (let c = 0; c < 3; c++) rgbBuf[i + c] = Math.min(255, Math.round(rgbBuf[i + c] * TINT[c]));
  return rgbBuf;
}

/** A seeded random stream per purpose, so adding one stream never shifts another. */
export const streamOf = (seed, name) => {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return prng((seed ^ h) >>> 0);
};
