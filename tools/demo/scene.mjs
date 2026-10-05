// The demo world: a fictional tank farm with a pipe rack, a stockyard with two piles surveyed
// twice, and the ground textures under them. Everything is procedural and seeded; no part of it
// comes from a real site or survey.
//
// Local frame (data-conventions section 1): metres, Y up, X east, Z south.

import { Part, box, cone, cylinder, decal, onPipe, onPlane, onShell, strip } from './geometry.mjs';
import { fbm, hash2, mix, prng, rgb, smoothstep, vnoise } from './noise.mjs';
import { Texture } from './render.mjs';

export const SITE = { x0: -64, z0: -64, x1: 64, z1: 64 };
export const YARD = { x0: 72, z0: -40, x1: 152, z1: 40 };
export const EPOCHS = [
  { id: 'e1', date: '2026-03-02' },
  { id: 'e2', date: '2026-04-13' },
];

const SAND_A = rgb(205, 178, 136);
const SAND_B = rgb(186, 152, 108);
const GRAVEL = rgb(168, 160, 148);
const CONCRETE = rgb(188, 186, 180);
const TRACK = rgb(198, 182, 150);

// ------------------------------------------------------------------ ground textures

/** Periodic sand albedo: a 128 m tile and a 2 km tint field, so the ground never repeats visibly. */
export function sandTextures(seed) {
  const N = 1024;
  const tile = new Float32Array(N * N * 3);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const big = fbm(u * 8, v * 8, seed + 1, 4, 8);
      const fine = fbm(u * 256, v * 256, seed + 2, 2, 256);
      // wind ripples: bands across the prevailing wind, broken up by noise
      const rip = Math.sin(
        (u * 0.8 + v * 0.6) * 2 * Math.PI * 180 + 6 * fbm(u * 16, v * 16, seed + 3, 2, 16),
      );
      const c = mix(SAND_A, SAND_B, smoothstep(0.3, 0.75, big));
      const k = 0.93 + 0.1 * fine + 0.025 * rip;
      const o = (y * N + x) * 3;
      tile[o] = c[0] * k;
      tile[o + 1] = c[1] * k;
      tile[o + 2] = c[2] * k;
    }
  const M = 256;
  const tint = new Float32Array(M * M * 3);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      const t = fbm(x / 32, y / 32, seed + 4, 4, 8);
      const o = (y * M + x) * 3;
      tint[o] = 0.92 + 0.16 * t;
      tint[o + 1] = 0.92 + 0.15 * t;
      tint[o + 2] = 0.93 + 0.12 * t;
    }
  return {
    tile: new Texture(N, N, tile, { x0: 0, z0: 0, x1: 128, z1: 128, wrap: true }),
    tint: new Texture(M, M, tint, { x0: 0, z0: 0, x1: 2048, z1: 2048, wrap: true }),
  };
}

/** Plain desert at (x, z) into out (used beyond the site and yard textures). */
export function sandAt(sand, x, z, foot, out) {
  sand.tile.sample(x, z, foot, out);
  const r = out[0],
    g = out[1],
    b = out[2];
  sand.tint.sample(x, z, foot, out);
  out[0] *= r;
  out[1] *= g;
  out[2] *= b;
}

const inRect = (x, z, x0, z0, x1, z1) => x >= x0 && x <= x1 && z >= z0 && z <= z1;

/** Distance from (x, z) to the segment a-b in plan. */
function segDist(x, z, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}

export const TANKS = [
  {
    id: 'T101',
    label: 'T-101',
    cx: -14,
    cz: -6,
    R: 9,
    H: 12,
    courses: 4,
    paint: rgb(226, 226, 220),
    roof: rgb(176, 178, 176),
  },
  {
    id: 'T102',
    label: 'T-102',
    cx: 14,
    cz: -8,
    R: 6,
    H: 9,
    courses: 3,
    paint: rgb(214, 204, 182),
    roof: rgb(168, 166, 160),
  },
];
const BUND = { x0: -34, z0: -24, x1: 30, z1: 14, h: 1.1, t: 0.4 };
const RACK = { x0: -30, x1: 30, z: 20, h: 5, w: 3, bay: 6 };
const BUILDING = { c: [-44, 0, 36], size: [8, 3.4, 5] };
const PUMP = { c: [2, 0, 25] };
const TRACKS = [
  [
    [-42, 70],
    [-42, 40],
  ],
  [
    [-42, 28],
    [8, 28],
  ],
  [
    [-42, 28],
    [-42, 40],
  ],
];

/** Site albedo (tank farm, 128 m square at 6.25 cm), on top of the same sand as everywhere. */
export function siteTexture(sand, seed) {
  const N = 2048;
  const px = (SITE.x1 - SITE.x0) / N;
  const out = new Float32Array(N * N * 3);
  const s = new Float32Array(3);
  for (let j = 0; j < N; j++) {
    const z = SITE.z0 + (j + 0.5) * px;
    for (let i = 0; i < N; i++) {
      const x = SITE.x0 + (i + 0.5) * px;
      sandAt(sand, x, z, px, s);
      let c = [s[0], s[1], s[2]];
      const grain = hash2(i, j, seed);
      // compacted tracks with tyre ruts
      let dTrack = Infinity;
      for (const [a, b] of TRACKS) dTrack = Math.min(dTrack, segDist(x, z, a, b));
      if (dTrack < 3.2) {
        const edge = smoothstep(3.2, 2.2, dTrack + 0.6 * (fbm(x / 2, z / 2, seed + 9) - 0.5));
        const rut = Math.abs(Math.abs(dTrack) - 1.0) < 0.22 ? 0.9 : 1;
        c = mix(
          c,
          TRACK.map((v) => v * rut * (0.95 + 0.08 * grain)),
          edge,
        );
      }
      // gravel inside the bund
      if (inRect(x, z, BUND.x0, BUND.z0, BUND.x1, BUND.z1)) {
        const g = 0.86 + 0.24 * grain + 0.08 * fbm(x * 2, z * 2, seed + 5);
        c = GRAVEL.map((v) => v * g);
      }
      // concrete under the rack, the pump and the building
      if (
        inRect(x, z, RACK.x0 - 2, RACK.z - 2.5, RACK.x1 + 2, RACK.z + 2.5) ||
        inRect(x, z, -1.5, 23, 6, 27.2)
      ) {
        c = CONCRETE.map((v) => v * (0.94 + 0.08 * grain) * (0.96 + 0.06 * fbm(x, z, seed + 6)));
      }
      if (inRect(x, z, -50, 31, -38, 41)) c = CONCRETE.map((v) => v * (0.95 + 0.06 * grain));
      // tank ring foundations
      for (const t of TANKS) {
        const d = Math.hypot(x - t.cx, z - t.cz);
        if (d < t.R + 1.2)
          c = CONCRETE.map((v) => v * (0.92 + 0.06 * grain) * (d > t.R + 1.05 ? 0.85 : 1));
      }
      // drain sump and an oil stain by the pump
      if (inRect(x, z, 7, 9, 8.6, 10.6)) c = c.map((v) => v * 0.35);
      const stain = Math.hypot(x - 4.2, z - 24.4) + 0.8 * (fbm(x * 1.5, z * 1.5, seed + 7) - 0.5);
      if (stain < 1.1) c = c.map((v) => v * (0.45 + 0.35 * smoothstep(0.4, 1.1, stain)));
      const o = (j * N + i) * 3;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
    }
  }
  return new Texture(N, N, out, { ...SITE });
}

// ------------------------------------------------------------------ stockyard

const PILES = {
  P01: { a: [92, -18], b: [110, -4], r: 9.5, h: { e1: 6.6, e2: 6.6 } },
  P02: { c: [132, 17], r: { e1: 8.5, e2: 10.5 }, h: { e1: 4.0, e2: 5.1 } },
};

/** 0 at the yard boundary, 1 from 10 m inside: the yard floor meets the desert seamlessly. */
function yardEdge(x, z) {
  return smoothstep(0, 10, Math.min(x - YARD.x0, YARD.x1 - x, z - YARD.z0, YARD.z1 - z));
}

/** The yard floor: a gentle fall to the south-east for drainage. */
function floorHeight(x, z) {
  return (0.004 * (x - YARD.x0 - 40) + 0.0025 * z) * yardEdge(x, z);
}

/** Yard surface height (local y) at (x, z) on survey `epoch`. */
export function yardHeight(x, z, epoch, seed) {
  const floor = floorHeight(x, z) + 0.06 * (fbm(x / 9, z / 9, seed + 20, 3) - 0.5) * yardEdge(x, z);
  const p1 = PILES.P01;
  const d1 = segDist(x, z, p1.a, p1.b) / p1.r;
  let h1 = d1 < 1 ? p1.h[epoch] * profile(d1) : 0;
  if (epoch === 'e2') {
    // loader face: the west end cut back, a bench in front of it
    const along =
      ((x - p1.a[0]) * (p1.b[0] - p1.a[0]) + (z - p1.a[1]) * (p1.b[1] - p1.a[1])) /
      Math.hypot(p1.b[0] - p1.a[0], p1.b[1] - p1.a[1]);
    const face = Math.max(0, (along - 6) * 1.4);
    h1 = Math.min(h1, face + 0.25 * Math.max(0, Math.min(1, (along - 1.5) / 3)));
  }
  const p2 = PILES.P02;
  const d2 = Math.hypot(x - p2.c[0], z - p2.c[1]) / p2.r[epoch];
  const h2 = d2 < 1 ? p2.h[epoch] * profile(d2) : 0;
  const rough = h1 + h2 > 0.02 ? 0.05 * (fbm(x * 1.3, z * 1.3, seed + 21, 3) - 0.5) : 0;
  return floor + Math.max(h1, h2) + rough;
}

/** Pile cross-section: angle-of-repose sides, a rounded crest and a soft toe. */
function profile(d) {
  const lin = 1 - d;
  return Math.min(lin, 0.88 + 0.12 * (1 - d * d * 4)) * smoothstep(0, 0.12, lin) + 0 * d;
}

/** Yard albedo for a survey: compacted floor, aggregate piles, a darker fresh face. */
export function yardTexture(sand, epoch, seed) {
  const N = 1024;
  const px = (YARD.x1 - YARD.x0) / N;
  const out = new Float32Array(N * N * 3);
  const s = new Float32Array(3);
  const FLOOR = rgb(196, 184, 160);
  const AGG = rgb(156, 146, 132);
  const FRESH = rgb(128, 120, 110);
  for (let j = 0; j < N; j++) {
    const z = YARD.z0 + (j + 0.5) * px;
    for (let i = 0; i < N; i++) {
      const x = YARD.x0 + (i + 0.5) * px;
      sandAt(sand, x, z, px, s);
      const edge = Math.min(x - YARD.x0, YARD.x1 - x, z - YARD.z0, YARD.z1 - z);
      let c = mix([s[0], s[1], s[2]], FLOOR, smoothstep(0, 6, edge));
      const floor = floorHeight(x, z);
      const above = yardHeight(x, z, epoch, seed) - floor;
      const grain = hash2(i, j, seed + (epoch === 'e1' ? 1 : 2));
      if (above > 0.08) {
        let a = AGG;
        if (epoch === 'e2') {
          const p1 = PILES.P01;
          const along =
            ((x - p1.a[0]) * (p1.b[0] - p1.a[0]) + (z - p1.a[1]) * (p1.b[1] - p1.a[1])) /
            Math.hypot(p1.b[0] - p1.a[0], p1.b[1] - p1.a[1]);
          if (along < 7.5 && segDist(x, z, p1.a, p1.b) < p1.r) a = FRESH;
        }
        c = mix(
          c,
          a.map((v) => v * (0.88 + 0.22 * grain)),
          smoothstep(0.08, 0.4, above),
        );
      } else {
        // wheel tracks of the loader, from the piles to the yard exit
        const tr = Math.min(
          Math.abs(segDist(x, z, [95, -6], [152, 2]) - 1.1),
          Math.abs(segDist(x, z, [128, 8], [152, 2]) - 1.1),
        );
        if (tr < 0.3) c = c.map((v) => v * (0.9 + 0.1 * smoothstep(0, 0.3, tr)));
        c = c.map((v) => v * (0.96 + 0.06 * grain));
      }
      const o = (j * N + i) * 3;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
    }
  }
  return new Texture(N, N, out, { ...YARD });
}

/** The yard surface as a renderable height field (cell metres), coloured by the ground texture. */
export function yardMesh(epoch, seed, cell = 0.5) {
  const nx = Math.round((YARD.x1 - YARD.x0) / cell);
  const nz = Math.round((YARD.z1 - YARD.z0) / cell);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const nrm = new Float32Array(pos.length);
  const col = new Float32Array(pos.length);
  const H = (x, z) => yardHeight(x, z, epoch, seed);
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const x = YARD.x0 + i * cell;
      const z = YARD.z0 + j * cell;
      const o = (j * (nx + 1) + i) * 3;
      pos[o] = x;
      pos[o + 1] = H(x, z);
      pos[o + 2] = z;
      const e = 0.25;
      const nxv = H(x - e, z) - H(x + e, z);
      const nzv = H(x, z - e) - H(x, z + e);
      const l = Math.hypot(nxv, 2 * e, nzv);
      nrm[o] = nxv / l;
      nrm[o + 1] = (2 * e) / l;
      nrm[o + 2] = nzv / l;
    }
  const idx = new Uint32Array(nx * nz * 6);
  let k = 0;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = d;
      idx[k++] = a;
      idx[k++] = d;
      idx[k++] = b;
    }
  return { pos, nrm, col, idx, ground: true };
}

/** Flat ground tiles everywhere else (finer near the site), coloured by the ground textures. */
export function groundMesh() {
  const pos = [];
  const idx = [];
  const quad = (x0, z0, x1, z1) => {
    const b = pos.length / 3;
    pos.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1);
    idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
  };
  for (let x = -256; x < 256; x += 16)
    for (let z = -256; z < 256; z += 16) {
      // the yard has its own surface
      if (x >= YARD.x0 && x + 16 <= YARD.x1 && z >= YARD.z0 && z + 16 <= YARD.z1) continue;
      if (x + 16 > YARD.x0 && x < YARD.x1 && z + 16 > YARD.z0 && z < YARD.z1) {
        // split the tiles the yard edge crosses into 4 m cells
        for (let a = x; a < x + 16; a += 4)
          for (let c = z; c < z + 16; c += 4) {
            if (a >= YARD.x0 && a + 4 <= YARD.x1 && c >= YARD.z0 && c + 4 <= YARD.z1) continue;
            quad(a, c, a + 4, c + 4);
          }
        continue;
      }
      quad(x, z, x + 16, z + 16);
    }
  for (let x = -3000; x < 3000; x += 250)
    for (let z = -3000; z < 3000; z += 250) {
      if (x >= -256 && x + 250 <= 256 && z >= -256 && z + 250 <= 256) continue;
      if (x + 250 > -256 && x < 256 && z + 250 > -256 && z < 256) {
        for (let a = x; a < x + 250; a += 50)
          for (let c = z; c < z + 250; c += 50) {
            if (a + 50 > -256 && a < 256 && c + 50 > -256 && c < 256) {
              for (let p = a; p < a + 50; p += 16)
                for (let q = c; q < c + 50; q += 16) {
                  const p1 = Math.min(p + 16, a + 50);
                  const q1 = Math.min(q + 16, c + 50);
                  if (p >= -256 && p1 <= 256 && q >= -256 && q1 <= 256) continue;
                  quad(p, q, p1, q1);
                }
              continue;
            }
            quad(a, c, a + 50, c + 50);
          }
        continue;
      }
      quad(x, z, x + 250, z + 250);
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

// ------------------------------------------------------------------ the asset

const STEEL = rgb(92, 102, 116);
const RUST = rgb(128, 66, 36);
const RUST_DARK = rgb(92, 46, 26);

/** Random outline radii for a blob decal. */
function blob(rnd, size, n = 18) {
  const out = [];
  let r = size;
  for (let k = 0; k < n; k++) {
    r = 0.6 * r + 0.4 * size * (0.65 + 0.7 * rnd());
    out.push(r);
  }
  return out;
}

/** A wandering line in patch coordinates, from (u, v) heading `dir` (radians). */
function wander(rnd, u, v, dir, len, step = 0.06, turn = 0.9) {
  const heading = dir;
  const pts = [[u, v]];
  for (let s = 0; s < len; s += step) {
    dir += (rnd() - 0.5) * turn + 0.15 * (heading - dir);
    u += Math.cos(dir) * step;
    v += Math.sin(dir) * step;
    pts.push([u, v]);
  }
  return pts;
}

/**
 * The fictional asset: two vertical storage tanks in a bund, a pipe rack, a pump and a small
 * building. Returns the parts (glTF nodes, with asset tags) and the defects the demo issues
 * describe, each with its surface point, normal and a camera for its photo.
 */
export function buildAsset(seed) {
  const rnd = prng(seed);
  const parts = [];
  const defects = [];
  const P = (name, tag, area) => {
    const p = new Part(name, tag, area);
    parts.push(p);
    return p;
  };

  for (const t of TANKS) {
    const area = `Tank ${t.label}`;
    const base = 0.3;
    const course = t.H / t.courses;
    const found = P(`${t.id}_Foundation`, `${t.label} ring foundation`, area);
    cylinder(found, [t.cx, 0, t.cz], [t.cx, base, t.cz], t.R + 0.5, 96, CONCRETE);
    for (let k = 0; k < t.courses; k++) {
      const part = P(`${t.id}_Shell_C${k + 1}`, `${t.label} shell course ${k + 1}`, area);
      const y0 = base + k * course;
      cylinder(
        part,
        [t.cx, y0, t.cz],
        [t.cx, y0 + course, t.cz],
        t.R,
        160,
        (p, _s, ang) => {
          const dirt = smoothstep(1.2, 0, p[1] - base) * 0.16;
          const streak = 0.04 * (vnoise(ang * 14, p[1] * 0.4, seed + 30) - 0.5);
          const weld = Math.abs(p[1] - y0) < 0.04 ? 0.06 : 0;
          const k2 = 1 - dirt - weld + streak;
          return [t.paint[0] * k2, t.paint[1] * k2 * 0.99, t.paint[2] * k2 * 0.97];
        },
        { caps: false, rows: 6 },
      );
    }
    const top = base + t.H;
    const roof = P(`${t.id}_Roof`, `${t.label} fixed cone roof`, area);
    cone(roof, [t.cx, top, t.cz], t.R + 0.05, t.R * 0.16, 160, t.roof);
    cylinder(
      roof,
      [t.cx, top + t.R * 0.16 - 0.1, t.cz],
      [t.cx, top + t.R * 0.16 + 0.6, t.cz],
      0.35,
      24,
      STEEL,
    );
    cylinder(
      roof,
      [t.cx + t.R * 0.5, top + t.R * 0.08 - 0.1, t.cz],
      [t.cx + t.R * 0.5, top + t.R * 0.08 + 0.5, t.cz],
      0.25,
      20,
      STEEL,
    );
    // wind girder and roof handrail
    const rail = P(`${t.id}_Handrail`, `${t.label} roof handrail`, area);
    cylinder(
      rail,
      [t.cx, top - 0.35, t.cz],
      [t.cx, top - 0.15, t.cz],
      t.R + 0.18,
      160,
      rgb(150, 152, 150),
      { caps: false },
    );
    const nPost = Math.round((2 * Math.PI * t.R) / 2.2);
    for (let k = 0; k < nPost; k++) {
      const a = (k / nPost) * Math.PI * 2;
      const x = t.cx + Math.cos(a) * (t.R - 0.15);
      const z = t.cz + Math.sin(a) * (t.R - 0.15);
      const yb = top + 0.02;
      cylinder(rail, [x, yb, z], [x, yb + 1.05, z], 0.03, 6, rgb(230, 190, 40), { caps: false });
      const a2 = ((k + 1) / nPost) * Math.PI * 2;
      const x2 = t.cx + Math.cos(a2) * (t.R - 0.15);
      const z2 = t.cz + Math.sin(a2) * (t.R - 0.15);
      cylinder(rail, [x, yb + 1.05, z], [x2, yb + 1.05, z2], 0.03, 6, rgb(230, 190, 40), {
        caps: false,
      });
    }
    // spiral stair on the north-east side
    const stair = P(`${t.id}_Stair`, `${t.label} spiral stair`, area);
    const steps = Math.round(t.H / 0.24);
    const a0 = -Math.PI * 0.15;
    const sweep = Math.PI * 0.75;
    for (let k = 0; k < steps; k++) {
      const s = k / steps;
      const a = a0 - sweep * s;
      const y = base + 0.2 + s * t.H;
      const r = t.R + 0.55;
      box(
        stair,
        [t.cx + Math.cos(a) * r, y, t.cz + Math.sin(a) * r],
        [0.9, 0.05, 0.28],
        rgb(110, 116, 120),
        -a,
      );
      if (k % 3 === 0) {
        const ro = t.R + 1.05;
        cylinder(
          stair,
          [t.cx + Math.cos(a) * ro, y, t.cz + Math.sin(a) * ro],
          [t.cx + Math.cos(a) * ro, y + 1.0, t.cz + Math.sin(a) * ro],
          0.03,
          6,
          rgb(230, 190, 40),
          { caps: false },
        );
      }
    }
    for (let k = 0; k < 24; k++) {
      const s0 = k / 24;
      const s1 = (k + 1) / 24;
      const ro = t.R + 1.05;
      const p0 = [
        t.cx + Math.cos(a0 - sweep * s0) * ro,
        base + 1.2 + s0 * t.H,
        t.cz + Math.sin(a0 - sweep * s0) * ro,
      ];
      const p1 = [
        t.cx + Math.cos(a0 - sweep * s1) * ro,
        base + 1.2 + s1 * t.H,
        t.cz + Math.sin(a0 - sweep * s1) * ro,
      ];
      cylinder(stair, p0, p1, 0.035, 6, rgb(230, 190, 40), { caps: false });
    }
    // outlet nozzle towards the pipe rack (south) and a manway
    const noz = P(`${t.id}_N1`, `${t.label} outlet nozzle N1`, area);
    const ny = base + 0.9;
    cylinder(noz, [t.cx, ny, t.cz + t.R - 0.2], [t.cx, ny, t.cz + t.R + 0.9], 0.22, 24, STEEL);
    cylinder(noz, [t.cx, ny, t.cz + t.R + 0.75], [t.cx, ny, t.cz + t.R + 0.85], 0.4, 24, STEEL);
    const man = P(`${t.id}_Manway`, `${t.label} shell manway`, area);
    const ma = Math.PI * 0.6;
    cylinder(
      man,
      [t.cx + Math.cos(ma) * (t.R - 0.1), base + 1.0, t.cz + Math.sin(ma) * (t.R - 0.1)],
      [t.cx + Math.cos(ma) * (t.R + 0.35), base + 1.0, t.cz + Math.sin(ma) * (t.R + 0.35)],
      0.42,
      28,
      t.paint,
    );
    t.nozzle = [t.cx, ny, t.cz + t.R + 0.9];
  }

  // bund walls
  const bund = [
    [
      'Bund_Wall_N',
      'Bund wall north',
      [(BUND.x0 + BUND.x1) / 2, BUND.h / 2, BUND.z0],
      [BUND.x1 - BUND.x0, BUND.h, BUND.t],
    ],
    [
      'Bund_Wall_S',
      'Bund wall south',
      [(BUND.x0 + BUND.x1) / 2, BUND.h / 2, BUND.z1],
      [BUND.x1 - BUND.x0, BUND.h, BUND.t],
    ],
    [
      'Bund_Wall_W',
      'Bund wall west',
      [BUND.x0, BUND.h / 2, (BUND.z0 + BUND.z1) / 2],
      [BUND.t, BUND.h, BUND.z1 - BUND.z0],
    ],
    [
      'Bund_Wall_E',
      'Bund wall east',
      [BUND.x1, BUND.h / 2, (BUND.z0 + BUND.z1) / 2],
      [BUND.t, BUND.h, BUND.z1 - BUND.z0],
    ],
  ];
  const bundParts = {};
  for (const [name, tag, c, size] of bund) {
    const p = P(name, tag, 'Bund');
    box(p, c, size, (q) =>
      CONCRETE.map((v) => v * (0.9 + 0.08 * vnoise(q[0] * 0.7 + q[2] * 0.7, q[1] * 2, seed + 40))),
    );
    bundParts[name] = p;
  }

  // pipe rack: bents every bay, two tiers, longitudinal beams
  const bents = [];
  for (let x = RACK.x0, k = 1; x <= RACK.x1 + 0.01; x += RACK.bay, k++) {
    const name = `Rack_Bent_${String(k).padStart(2, '0')}`;
    const p = P(name, `Pipe rack bent ${k}`, 'Pipe rack');
    for (const dz of [-RACK.w / 2, RACK.w / 2])
      box(p, [x, RACK.h / 2, RACK.z + dz], [0.3, RACK.h, 0.3], STEEL);
    box(p, [x, RACK.h, RACK.z], [0.3, 0.3, RACK.w + 0.3], STEEL);
    box(p, [x, RACK.h - 1.6, RACK.z], [0.25, 0.25, RACK.w + 0.3], STEEL);
    for (const dz of [-RACK.w / 2, RACK.w / 2])
      box(p, [x, 0.15, RACK.z + dz], [0.7, 0.3, 0.7], CONCRETE);
    bents.push({ part: p, x, k });
  }
  const beams = P('Rack_Beams', 'Pipe rack longitudinal beams', 'Pipe rack');
  for (const dz of [-RACK.w / 2, RACK.w / 2])
    for (const y of [RACK.h, RACK.h - 1.6])
      box(beams, [(RACK.x0 + RACK.x1) / 2, y, RACK.z + dz], [RACK.x1 - RACK.x0, 0.2, 0.2], STEEL);

  // lines on the rack and down to the tank nozzles
  const lines = [
    {
      id: 'Line_101',
      tag: 'Line 101 (T-101 outlet, insulated)',
      z: RACK.z - 0.8,
      r: 0.28,
      col: rgb(196, 198, 196),
      tank: TANKS[0],
    },
    {
      id: 'Line_102',
      tag: 'Line 102 (T-102 outlet)',
      z: RACK.z,
      r: 0.18,
      col: rgb(196, 166, 60),
      tank: TANKS[1],
    },
    { id: 'Line_FW', tag: 'Fire water ring main', z: RACK.z + 0.8, r: 0.15, col: rgb(170, 52, 40) },
  ];
  const lineParts = {};
  for (const L of lines) {
    const p = P(L.id, L.tag, 'Pipe rack');
    const y = RACK.h + 0.15 + L.r;
    cylinder(p, [RACK.x0 - 1, y, L.z], [RACK.x1 + 1, y, L.z], L.r, 28, L.col, { rows: 24 });
    if (L.tank) {
      const n = L.tank.nozzle;
      const yl = n[1];
      cylinder(p, [n[0], yl, n[2] - 0.1], [n[0], yl, L.z], L.r, 28, L.col);
      cylinder(p, [n[0], yl - L.r, L.z], [n[0], y + L.r, L.z], L.r, 28, L.col);
    }
    for (let x = RACK.x0 + 3; x < RACK.x1; x += RACK.bay)
      box(p, [x, RACK.h + 0.15 + L.r * 0.5, L.z], [0.12, L.r, 0.12], STEEL);
    lineParts[L.id] = { part: p, ...L, y };
  }

  // pump and building
  const pump = P('P101_Pump', 'Pump P-101', 'Pump station');
  box(pump, [PUMP.c[0], 0.15, PUMP.c[2]], [3.2, 0.3, 1.6], STEEL);
  cylinder(
    pump,
    [PUMP.c[0] - 1.3, 0.75, PUMP.c[2]],
    [PUMP.c[0] + 0.2, 0.75, PUMP.c[2]],
    0.38,
    28,
    rgb(40, 92, 160),
  );
  box(pump, [PUMP.c[0] + 0.9, 0.7, PUMP.c[2]], [0.9, 0.8, 0.8], rgb(70, 78, 88));
  cylinder(
    pump,
    [PUMP.c[0] + 0.9, 1.1, PUMP.c[2]],
    [PUMP.c[0] + 0.9, RACK.h + 0.4, RACK.z + 0.8 + 0.2],
    0.12,
    16,
    rgb(170, 52, 40),
  );
  const bld = P('Control_Building', 'Control building', 'Utilities');
  box(bld, [BUILDING.c[0], BUILDING.size[1] / 2, BUILDING.c[2]], BUILDING.size, rgb(206, 200, 188));
  box(
    bld,
    [BUILDING.c[0], BUILDING.size[1] + 0.1, BUILDING.c[2]],
    [BUILDING.size[0] + 0.3, 0.2, BUILDING.size[2] + 0.3],
    rgb(122, 128, 134),
  );
  box(
    bld,
    [BUILDING.c[0] + 1.5, 1.05, BUILDING.c[2] + BUILDING.size[2] / 2 + 0.02],
    [1.0, 2.1, 0.06],
    rgb(80, 96, 120),
  );
  box(
    bld,
    [BUILDING.c[0] - 2, 1.0, BUILDING.c[2] + BUILDING.size[2] / 2 + 0.36],
    [1.6, 0.9, 0.7],
    rgb(200, 200, 200),
  );

  // ------------------------------------------------------------------ defects
  const T1 = TANKS[0];
  const T2 = TANKS[1];
  const byName = (n) => parts.find((p) => p.name === n);
  // decal colours mottled like real corrosion and coating breakdown
  const mottled = (base, k) => (u, v) =>
    base.map((c) => c * (0.72 + 0.5 * vnoise(u * 11 + k * 7, v * 11, seed + 50 + k)));

  // F01: corrosion on T-101 shell course 1 beside the outlet nozzle
  {
    const m = onShell(T1.cx, T1.cz, T1.R, Math.PI * 0.42, 0.3 + 1.7);
    const p = byName('T101_Shell_C1');
    decal(p, m.at, m.normalAt, blob(rnd, 0.45), mottled(RUST, 1));
    decal(
      p,
      (u, v) => m.at(u + 0.1, v + 0.05),
      m.normalAt,
      blob(rnd, 0.22),
      mottled(RUST_DARK, 2),
      0.016,
    );
    for (let k = 0; k < 4; k++) {
      const u0 = (rnd() - 0.5) * 0.6;
      const pts = [];
      for (let v = -0.1; v > -1.25 - rnd() * 0.3; v -= 0.08)
        pts.push([u0 + 0.03 * Math.sin(v * 9 + k), v]);
      strip(p, m.at, m.normalAt, pts, (s) => 0.07 * (1 - 0.8 * s), RUST, 0.014);
    }
    defects.push({
      code: 'F01',
      classId: 'corrosion',
      severity: 2,
      node: 'T101_Shell_C1',
      mapping: m,
      extent: [0.8, 1.6],
      offset: [0, -0.35],
      title: 'Corrosion on shell course 1 beside the outlet nozzle',
      note: 'Rust patch about 0.9 m across with streaks running down the shell. Coating broken through. Clean back, check wall thickness with UT, recoat.',
    });
  }
  // F02: rust staining below the roof edge of T-101 (north-east)
  {
    const m = onShell(T1.cx, T1.cz, T1.R, -Math.PI * 0.35, 0.3 + T1.H - 0.6);
    const p = byName('T101_Shell_C4');
    for (let k = 0; k < 7; k++) {
      const u0 = (k - 3) * 0.32 + (rnd() - 0.5) * 0.1;
      const pts = [];
      const len = 0.6 + rnd() * 1.4;
      for (let v = 0.4; v > 0.4 - len; v -= 0.08) pts.push([u0 + 0.02 * Math.sin(v * 7 + k), v]);
      strip(p, m.at, m.normalAt, pts, (s) => 0.09 * (1 - 0.7 * s), k % 2 ? RUST : RUST_DARK);
    }
    defects.push({
      code: 'F02',
      classId: 'corrosion',
      severity: 1,
      node: 'T101_Shell_C4',
      mapping: m,
      extent: [2.6, 1.9],
      offset: [0, -0.3],
      title: 'Rust staining below the roof edge',
      note: 'Streaks from the wind girder down course 4. Surface staining only, no section loss seen. Monitor at the next inspection.',
    });
  }
  // F03: crack in the north bund wall, inside face
  {
    const wall = bundParts.Bund_Wall_N;
    const m = onPlane([-6, 0.55, BUND.z0 + BUND.t / 2], [1, 0, 0], [0, 1, 0]);
    // the inside face points south (+Z): u east, v up gives normal +Z
    const pts = wander(rnd, -0.95, 0.42, -0.36, 1.9, 0.05, 0.6);
    strip(
      wall,
      m.at,
      m.normalAt,
      pts,
      (s) => 0.035 + 0.025 * Math.sin(s * Math.PI),
      rgb(60, 58, 54),
      0.01,
    );
    const branch = wander(rnd, pts[14][0], pts[14][1], -1.2, 0.3, 0.05, 0.6);
    strip(wall, m.at, m.normalAt, branch, 0.02, rgb(70, 68, 64), 0.011);
    defects.push({
      code: 'F03',
      classId: 'crack',
      severity: 2,
      node: 'Bund_Wall_N',
      mapping: m,
      extent: [2.3, 1.0],
      offset: [0, 0],
      title: 'Diagonal crack in the north bund wall',
      note: 'Crack about 2 m long through the full wall height on the inside face. Bund must hold the tank contents: seal and monitor for movement.',
    });
  }
  // F04: section loss at a pipe rack column base (bent 4, south column)
  {
    const b = bents[3];
    const x = b.x;
    const zc = RACK.z + RACK.w / 2;
    const m = onPlane([x, 0.75, zc + 0.151], [1, 0, 0], [0, 1, 0]);
    decal(b.part, m.at, m.normalAt, blob(rnd, 0.14, 14), mottled(RUST_DARK, 3), 0.006);
    decal(
      b.part,
      (u, v) => m.at(u * 0.8, v * 1.6 - 0.12),
      m.normalAt,
      blob(rnd, 0.12, 14),
      mottled(RUST, 4),
      0.008,
    );
    defects.push({
      code: 'F04',
      classId: 'corrosion',
      severity: 3,
      node: b.part.name,
      mapping: m,
      extent: [0.5, 0.9],
      offset: [0, -0.1],
      title: 'Heavy corrosion at a rack column base',
      note: 'Pitting and flaking at the base of the south column of bent 4 where water collects. Possible section loss: measure and repair before the next load change.',
    });
  }
  // F05: damaged insulation jacket on line 101
  {
    const L = lineParts.Line_101;
    const a = [RACK.x0 - 1, L.y, L.z];
    const bb = [RACK.x1 + 1, L.y, L.z];
    const m = onPipe(a, bb, L.r, 0.62, Math.PI * 0.5);
    decal(
      L.part,
      m.at,
      m.normalAt,
      blob(rnd, 0.32, 20).map((r, k) => r * (k % 2 ? 1.3 : 0.9)),
      mottled(rgb(70, 70, 66), 5),
      0.01,
    );
    decal(
      L.part,
      (u, v) => m.at(u * 0.6, v * 0.5),
      m.normalAt,
      blob(rnd, 0.2, 16),
      mottled(rgb(150, 120, 80), 6),
      0.013,
    );
    defects.push({
      code: 'F05',
      classId: 'damage',
      severity: 2,
      node: 'Line_101',
      mapping: m,
      extent: [0.9, 0.7],
      offset: [0, 0],
      title: 'Insulation jacket torn open on line 101',
      note: 'Aluminium jacket split and the insulation exposed on the pipe rack. Water ingress risk (corrosion under insulation). Replace the jacket section.',
    });
  }
  // F06: coating breakdown on T-102 shell course 2
  {
    const m = onShell(T2.cx, T2.cz, T2.R, Math.PI * 1.15, 0.3 + 4.1);
    const p = byName('T102_Shell_C2');
    for (let k = 0; k < 6; k++) {
      const du = (rnd() - 0.5) * 1.4;
      const dv = (rnd() - 0.5) * 0.9;
      decal(
        p,
        (u, v) => m.at(u + du, v + dv),
        m.normalAt,
        blob(rnd, 0.12 + rnd() * 0.12, 14),
        mottled(rgb(150, 154, 156), 7),
        0.01,
      );
    }
    defects.push({
      code: 'F06',
      classId: 'damage',
      severity: 1,
      node: 'T102_Shell_C2',
      mapping: m,
      extent: [1.9, 1.4],
      offset: [0, 0],
      title: 'Coating breakdown on T-102 shell course 2',
      note: 'Paint flaking in small patches down to the grey primer. No rust yet. Touch up at the next maintenance window.',
    });
  }

  return { parts, defects };
}

/** Sun direction (towards the sun): mid-morning, from the south-east, 48 degrees high. */
export const SUN = (() => {
  const el = (48 * Math.PI) / 180;
  const az = (128 * Math.PI) / 180; // clockwise from north
  // north is -Z, east +X
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
})();
