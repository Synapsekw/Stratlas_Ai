// The demo road: 300 m of a fictional two-lane desert access road, painted as an orthomosaic
// (4 cm) with a handful of pavement distresses, plus its centreline and the defect outlines the
// road builder (road.build) turns into issues and PCI units. Local frame of the road project.

import { fbm, hash2, mix, prng, rgb, smoothstep } from './noise.mjs';
import { sandAt } from './scene.mjs';

export const ROAD = { length: 300, lanes: 2, laneWidth: 3.65, shoulder: 1.4, res: 0.04 };
const HALF = ROAD.lanes * ROAD.laneWidth * 0.5;

/** Centreline offset z at x (a gentle S-bend) and its slope. */
const zc = (x) => 9 * Math.sin(x / 70) - 0.02 * x;
const dzc = (x) => (9 / 70) * Math.cos(x / 70) - 0.02;

export const EXTENT = { x0: -166, x1: 166, z0: -34, z1: 34 };

/** Signed offset from the centreline (+ to the right when driving east) and chainage (m). */
function roadCoords(x, z, arc) {
  const k = dzc(x);
  const d = (z - zc(x)) / Math.sqrt(1 + k * k);
  // walk back along the normal to the station x on the centreline
  const xs = x + (d * k) / Math.sqrt(1 + k * k);
  const s = arc(xs);
  return { d, s };
}

/** Arc length from the west end at x, by table. */
function arcTable() {
  const x0 = -ROAD.length / 2 - 20;
  const n = 4000;
  const step = (ROAD.length + 40) / n;
  const tab = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const xa = x0 + (i - 1) * step;
    const xb = xa + step;
    tab[i] = tab[i - 1] + Math.hypot(step, zc(xb) - zc(xa));
  }
  const start = (() => {
    const t = (-ROAD.length / 2 - x0) / step;
    const i = Math.floor(t);
    return tab[i] + (tab[i + 1] - tab[i]) * (t - i);
  })();
  return (x) => {
    const t = Math.min(n - 1e-6, Math.max(0, (x - x0) / step));
    const i = Math.floor(t);
    return tab[i] + (tab[i + 1] - tab[i]) * (t - i) - start;
  };
}

/** Point on the road at chainage s (m) and offset d (m, + right of the direction of travel). */
function pointAt(s, d, arc) {
  // invert the arc table by bisection
  let a = -ROAD.length / 2 - 20;
  let b = ROAD.length / 2 + 20;
  for (let k = 0; k < 50; k++) {
    const m = (a + b) / 2;
    if (arc(m) < s) a = m;
    else b = m;
  }
  const x = (a + b) / 2;
  const k = dzc(x);
  const n = Math.sqrt(1 + k * k);
  return [x - (d * k) / n, zc(x) + d / n];
}

/**
 * Paint the road. Returns the RGBA ortho (north up, x0/z0 the top-left corner in the local frame),
 * the centreline (local x, z with chainage) and the defects (local outlines, class ids, severity).
 */
export function buildRoad(seed, sand) {
  const rnd = prng(seed + 500);
  const arc = arcTable();
  const W = Math.round((EXTENT.x1 - EXTENT.x0) / ROAD.res);
  const H = Math.round((EXTENT.z1 - EXTENT.z0) / ROAD.res);
  const img = Buffer.alloc(W * H * 4);
  const ASPHALT = rgb(74, 74, 76);
  const SHOULDER = rgb(104, 102, 98);
  const WHITE = rgb(226, 226, 220);
  const s3 = new Float32Array(3);

  // ------------------------------------------------------------------ defects (patch coordinates s, d)
  const defects = [];
  const add = (classId, severity, paint, outline, kind = 'Polygon') =>
    defects.push({ classId, severity, paint, outline, kind });
  // transverse cracks: a wandering line across one or both lanes
  for (const [s0, sev, full] of [
    [22, 1, false],
    [61, 2, true],
    [148, 1, false],
    [233, 2, true],
  ]) {
    const pts = [];
    let s = s0;
    const d0 = full ? -HALF + 0.2 : -HALF + 0.3;
    const d1 = full ? HALF - 0.2 : -0.2;
    for (let d = d0; d <= d1; d += 0.1) {
      s += (rnd() - 0.5) * 0.08;
      pts.push([s, d]);
    }
    add(
      'transverse-cracking',
      sev,
      { line: pts, width: sev === 1 ? 0.012 : 0.022 },
      pts,
      'LineString',
    );
  }
  // longitudinal cracks in the right wheel path
  for (const [s0, len, sev] of [
    [92, 9, 2],
    [190, 6, 1],
  ]) {
    const pts = [];
    let d = 1.0 + (rnd() - 0.5) * 0.2;
    for (let s = s0; s <= s0 + len; s += 0.1) {
      d += (rnd() - 0.5) * 0.03;
      pts.push([s, d]);
    }
    add('longitudinal-cracking', sev, { line: pts, width: 0.016 }, pts, 'LineString');
  }
  // alligator cracking: a cell network in an area
  for (const [s0, d0, ls, ld, sev] of [
    [104, 0.4, 3.2, 2.2, 3],
    [262, -2.6, 2.4, 1.6, 2],
  ]) {
    const seeds = [];
    for (let k = 0; k < Math.round(ls * ld * 9); k++)
      seeds.push([s0 + rnd() * ls, d0 + rnd() * ld]);
    add('alligator-cracking', sev, { cells: seeds, box: [s0, d0, ls, ld] }, rect(s0, d0, ls, ld));
  }
  // potholes
  for (const [s0, d0, r, sev] of [
    [127, -1.6, 0.35, 2],
    [129.5, -1.2, 0.22, 1],
    [210, 1.3, 0.45, 3],
  ]) {
    const out = [];
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const rr = r * (0.8 + 0.4 * rnd());
      out.push([s0 + Math.cos(a) * rr, d0 + Math.sin(a) * rr]);
    }
    add('potholes', sev, { hole: [s0, d0, r] }, out);
  }
  // a utility cut patch, raveling and bleeding
  add('patching', 1, { patch: [170, -3.3, 2.6, 2.4] }, rect(170, -3.3, 2.6, 2.4));
  add('raveling', 2, { ravel: [44, 0.6, 5, 2.4] }, rect(44, 0.6, 5, 2.4));
  add('bleeding', 1, { bleed: [282, -1.4, 4, 0.9] }, rect(282, -1.4, 4, 0.9));

  function rect(s0, d0, ls, ld) {
    return [
      [s0, d0],
      [s0 + ls, d0],
      [s0 + ls, d0 + ld],
      [s0, d0 + ld],
    ];
  }

  // ------------------------------------------------------------------ painting
  for (let j = 0; j < H; j++) {
    const z = EXTENT.z0 + (j + 0.5) * ROAD.res;
    for (let i = 0; i < W; i++) {
      const x = EXTENT.x0 + (i + 0.5) * ROAD.res;
      const { d, s } = roadCoords(x, z, arc);
      const ad = Math.abs(d);
      const grain = hash2(i, j, seed + 600);
      sandAt(sand, x + 500, z + 500, ROAD.res, s3);
      let c = [s3[0], s3[1], s3[2]];
      const onRoad = s >= -14 && s <= ROAD.length + 14;
      if (onRoad && ad < HALF + ROAD.shoulder + 1.2) {
        // gravel verge, then the shoulder, then the carriageway
        const verge = mix(
          c,
          rgb(160, 150, 136),
          0.6 * smoothstep(HALF + ROAD.shoulder + 1.2, HALF + ROAD.shoulder + 0.2, ad),
        );
        c = verge.map((v) => v * (0.9 + 0.2 * grain));
        if (ad < HALF + ROAD.shoulder) c = SHOULDER.map((v) => v * (0.9 + 0.2 * grain));
        if (ad < HALF) {
          const wear =
            1 + 0.06 * smoothstep(0.5, 0, Math.abs(Math.abs(d - Math.sign(d) * HALF * 0.5) - 0.85));
          const patchy = 0.94 + 0.12 * fbm(x / 3, z / 3, seed + 601, 3);
          c = ASPHALT.map((v) => v * wear * patchy * (0.84 + 0.32 * grain));
        }
        // markings: edge lines and a dashed centre line
        if (Math.abs(ad - HALF) < 0.075) c = WHITE.map((v) => v * (0.9 + 0.1 * grain));
        if (ad < 0.06 && ((s % 9) + 9) % 9 < 3) c = WHITE.map((v) => v * (0.88 + 0.1 * grain));
      }
      const o = (j * W + i) * 4;
      img[o] = Math.round(Math.min(1, c[0]) * 255);
      img[o + 1] = Math.round(Math.min(1, c[1]) * 255);
      img[o + 2] = Math.round(Math.min(1, c[2]) * 255);
      img[o + 3] = 255;
    }
  }

  // defects painted over the pavement, pixel by pixel inside each one's box
  const toPix = (x, z) => [(x - EXTENT.x0) / ROAD.res, (z - EXTENT.z0) / ROAD.res];
  for (const df of defects) {
    const pts = df.outline.map(([s, d]) => pointAt(s, d, arc));
    const xs = pts.map((p) => p[0]);
    const zs = pts.map((p) => p[1]);
    const [pi0, pj0] = toPix(Math.min(...xs) - 0.6, Math.min(...zs) - 0.6);
    const [pi1, pj1] = toPix(Math.max(...xs) + 0.6, Math.max(...zs) + 0.6);
    for (let j = Math.max(0, Math.floor(pj0)); j < Math.min(H, Math.ceil(pj1)); j++)
      for (let i = Math.max(0, Math.floor(pi0)); i < Math.min(W, Math.ceil(pi1)); i++) {
        const x = EXTENT.x0 + (i + 0.5) * ROAD.res;
        const z = EXTENT.z0 + (j + 0.5) * ROAD.res;
        const { d, s } = roadCoords(x, z, arc);
        const k = paintDefect(df.paint, s, d, hash2(i, j, seed + 700));
        if (k === null) continue;
        const o = (j * W + i) * 4;
        for (let c = 0; c < 3; c++)
          img[o + c] = Math.max(0, Math.min(255, Math.round(img[o + c] * k[c])));
      }
    df.local = df.kind === 'LineString' ? pts : [...pts, pts[0]];
  }

  const centreline = [];
  for (let s = 0; s <= ROAD.length + 1e-6; s += 10) {
    const [x, z] = pointAt(s, 0, arc);
    centreline.push({ x, z, km: s / 1000 });
  }
  return { rgba: img, width: W, height: H, centreline, defects };
}

/** Darkening (or lightening) factors of a defect at road coordinates, or null outside it. */
function paintDefect(p, s, d, grain) {
  if (p.line) {
    let best = Infinity;
    for (let k = 0; k + 1 < p.line.length; k++) {
      const [s0, d0] = p.line[k];
      const [s1, d1] = p.line[k + 1];
      const ds = s1 - s0;
      const dd = d1 - d0;
      const t = Math.max(0, Math.min(1, ((s - s0) * ds + (d - d0) * dd) / (ds * ds + dd * dd)));
      best = Math.min(best, Math.hypot(s - s0 - t * ds, d - d0 - t * dd));
    }
    if (best > p.width * 2.5) return null;
    const k = best < p.width ? 0.35 : 0.35 + 0.65 * smoothstep(p.width, p.width * 2.5, best);
    return [k, k, k];
  }
  if (p.cells) {
    const [s0, d0, ls, ld] = p.box;
    if (s < s0 || s > s0 + ls || d < d0 || d > d0 + ld) return null;
    let a = Infinity;
    let b = Infinity;
    for (const [cs, cd] of p.cells) {
      const q = Math.hypot(s - cs, d - cd);
      if (q < a) {
        b = a;
        a = q;
      } else if (q < b) b = q;
    }
    const edge = b - a;
    const k = edge < 0.025 ? 0.4 : 0.92 + 0.08 * grain;
    return [k, k, k];
  }
  if (p.hole) {
    const [hs, hd, r] = p.hole;
    const q = Math.hypot(s - hs, d - hd) / r;
    if (q > 1.25) return null;
    const k = q < 0.85 ? 0.3 + 0.15 * grain : q < 1 ? 0.55 : 0.85 + 0.1 * grain;
    return [k, k * 0.98, k * 0.96];
  }
  if (p.patch) {
    const [s0, d0, ls, ld] = p.patch;
    if (s < s0 || s > s0 + ls || d < d0 || d > d0 + ld) return null;
    const rim = Math.min(s - s0, s0 + ls - s, d - d0, d0 + ld - d) < 0.05;
    const k = rim ? 0.45 : 0.78 + 0.08 * grain;
    return [k, k, k];
  }
  if (p.ravel) {
    const [s0, d0, ls, ld] = p.ravel;
    if (s < s0 || s > s0 + ls || d < d0 || d > d0 + ld) return null;
    const k = grain > 0.8 ? 0.55 : grain < 0.25 ? 1.45 : 1.15;
    return [k, k * 0.98, k * 0.94];
  }
  if (p.bleed) {
    const [s0, d0, ls, ld] = p.bleed;
    if (s < s0 || s > s0 + ls || d < d0 || d > d0 + ld) return null;
    return [0.55, 0.55, 0.57];
  }
  return null;
}
