/**
 * The stockpile kit on the survey engine (M11 G2, ADR 0009): the kit's bases and sums now go
 * through `@aio/survey` (`Accumulator`, `fitPlane`, `perimeterLevels`), and its numbers must stay
 * what they were. Golden regression: the arithmetic as it was before (frozen below) against the
 * engine path, exactly (`toBe`), on the synthetic pile, the volumetric demo
 * (`apps/desktop/demo/demo-tank-farm`, or QUADRION_DEMO_DIR) and the Masafi package (as
 * masafi.test.ts finds it) when they are present. Read only.
 *
 * And the general engine (coverage weights, bases sampled at the cell size) on the kit's grids
 * wrapped as a surface, against the kit's own numbers on the same line: plane, avg and low within
 * 3%; the kit's `tin` (a membrane) and the engine's `smart` (Delaunay) are different bases.
 */
import type { SurfaceRef, VolumeBaseId } from '@aio/schema';
import { compareItem, type ResolvedSurface } from '@aio/survey';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { syntheticPile } from '../testing';
import {
  densify,
  editGeometry,
  editVolumes,
  spans,
  type EditGeometry,
  type EN,
  type Surface,
} from './edit';
import { localToEN, pileSurface as kitSurface } from './frame';
import { decodeDsm, decodePile, type PileGrid } from './kitdata';
import { BASE_IDS, gridBase, pileEngineSurface, pileVolume } from './volume';

// ------------------------------------------------------------------ the arithmetic before G2

function legacyPileVolume(g: PileGrid, epoch: string, base: VolumeBaseId) {
  const o = g.ep[epoch];
  if (!o?.m) return null;
  const { m, z } = o;
  const baseAt = gridBase(o, base, g);
  let fill = 0;
  let cut = 0;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const i = y * g.w + x;
      if (!m[i]) continue;
      const d = (z[i] ?? 0) / 100 + g.zoff - baseAt(x, y, i);
      if (d > 0) fill += d;
      else cut -= d;
    }
  const a = g.res * g.res;
  return { fill: fill * a, cut: cut * a, net: (fill - cut) * a };
}

function legacyFits(ring: readonly EN[], surf: Surface) {
  let x0 = Infinity;
  let y0 = Infinity;
  for (const [E, N] of ring) {
    x0 = Math.min(x0, E);
    y0 = Math.min(y0, N);
  }
  const bs: [number, number, number][] = [];
  for (const [E, N] of densify(ring, 0.5)) {
    const z = surf(E, N);
    if (z != null) bs.push([E, N, z]);
  }
  if (bs.length < 3) return null;
  let lo = Infinity;
  let sum = 0;
  for (const q of bs) {
    lo = Math.min(lo, q[2]);
    sum += q[2];
  }
  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = [0, 0, 0];
  for (const [E, N, z] of bs) {
    const v = [1, E - x0, N - y0];
    for (let i = 0; i < 3; i++) {
      const row = a[i];
      if (!row) continue;
      r[i] = (r[i] ?? 0) + (v[i] ?? 0) * z;
      for (let j = 0; j < 3; j++) row[j] = (row[j] ?? 0) + (v[i] ?? 0) * (v[j] ?? 0);
    }
  }
  const M = a.map((row, i) => [...row, r[i] ?? 0]);
  const at = (i: number, j: number) => M[i]?.[j] ?? 0;
  for (let i = 0; i < 3; i++) {
    let pv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(at(k, i)) > Math.abs(at(pv, i))) pv = k;
    const mi = M[i];
    const mp = M[pv];
    if (mi && mp) {
      M[i] = mp;
      M[pv] = mi;
    }
    if (Math.abs(at(i, i)) < 1e-9) continue;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = at(k, i) / at(i, i);
      const rk = M[k];
      const ri = M[i];
      if (!rk || !ri) continue;
      for (let q = i; q < 4; q++) rk[q] = (rk[q] ?? 0) - f * (ri[q] ?? 0);
    }
  }
  const pc = [0, 1, 2].map((i) => (Math.abs(at(i, i)) < 1e-9 ? 0 : at(i, 3) / at(i, i)));
  return { low: lo, avg: sum / bs.length, plane: pc, x0, y0 };
}

function legacyEditVolumes(g: EditGeometry, gridX0: number, gridY1: number) {
  const R = 0.1;
  const A = R * R;
  const acc = Object.fromEntries(BASE_IDS.map((b) => [b, { fill: 0, cut: 0 }])) as Record<
    VolumeBaseId,
    { fill: number; cut: number }
  >;
  const [, y0, , y1] = g.bbox;
  for (let j = Math.floor((gridY1 - y1) / R); j <= Math.ceil((gridY1 - y0) / R); j++) {
    const N = gridY1 - (j + 0.5) * R;
    const xs = spans(g.ring, N);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ia = Math.ceil(((xs[k] ?? 0) - gridX0) / R - 0.5);
      const ib = Math.floor(((xs[k + 1] ?? 0) - gridX0) / R - 0.5);
      for (let i = ia; i <= ib; i++) {
        const E = gridX0 + (i + 0.5) * R;
        const z = g.surf(E, N);
        if (z == null) continue;
        for (const b of BASE_IDS) {
          const d = z - g.baseAt(b, E, N);
          if (d > 0) acc[b].fill += d;
          else acc[b].cut -= d;
        }
      }
    }
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return Object.fromEntries(
    BASE_IDS.map((b) => [
      b,
      {
        fill: r1(acc[b].fill * A),
        cut: r1(acc[b].cut * A),
        net: r1((acc[b].fill - acc[b].cut) * A),
      },
    ]),
  );
}

// -------------------------------------------------------------------------------- the data

interface KitSet {
  name: string;
  root: string;
  data: string;
  origin: [number, number, number];
}

const here = fileURLToPath(new URL('.', import.meta.url));
const ALL: KitSet[] = [
  {
    name: 'volumetric demo',
    root:
      process.env.QUADRION_DEMO_DIR ??
      join(here, '..', '..', '..', '..', 'apps', 'desktop', 'demo', 'demo-tank-farm'),
    data: 'volumetric/data',
    origin: [0, 0, 0],
  },
  {
    name: 'Masafi',
    root:
      process.env.QUADRION_MASAFI ??
      process.env.STRATLAS_MASAFI ??
      'E:\\Stratlas Data\\projects\\masafi',
    data: 'legacy/data',
    origin: [212624, 3201610.5, 51],
  },
];
const SETS = ALL.filter((s) => existsSync(join(s.root, 'volumes.json')));

interface VolumesJson {
  captures: { epoch: string }[];
  piles: { id: string; epochs: Record<string, { ring: [number, number][] }> }[];
}

function load(s: KitSet) {
  const read = (rel: string) => readFileSync(join(s.root, rel), 'utf8');
  const vols = JSON.parse(read('volumes.json')) as VolumesJson;
  const manifest = existsSync(join(s.root, 'manifest.json'))
    ? (JSON.parse(read('manifest.json')) as { origin?: [number, number, number] })
    : {};
  const origin = s.name === 'Masafi' ? s.origin : (manifest.origin ?? s.origin);
  return { read, vols, origin };
}

// ---------------------------------------------------------------------------------- tests

describe('the kit through the survey engine: numbers unchanged', () => {
  it('on the synthetic pile, every date and base', async () => {
    const p = await decodePile(syntheticPile().text);
    for (const e of Object.keys(p.ep))
      for (const b of BASE_IDS) {
        const now = pileVolume(p, e, b);
        const was = legacyPileVolume(p, e, b);
        expect(now && { fill: now.fill, cut: now.cut, net: now.net }).toEqual(was);
      }
  });

  it('on edited lines over a synthetic block', () => {
    const surf: Surface = (E, N) =>
      E > 3 && E < 7 && N > 3 && N < 7 ? 52 + 0.1 * E : 50 + 0.01 * N;
    for (const ring of [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      [
        [1.3, 0.2],
        [9.1, 1.7],
        [8.2, 9.4],
        [0.4, 7.9],
        [2.2, 4.4],
      ],
    ] as EN[][]) {
      const g = editGeometry(ring, surf);
      const was = legacyFits(ring, surf);
      if (!g || !was) throw new Error('no geometry');
      expect(g.low).toBe(was.low);
      expect(g.avg).toBe(was.avg);
      const [p0 = 0, p1 = 0, p2 = 0] = was.plane;
      expect(g.baseAt('plane', 5.5, 4.25)).toBe(p0 + p1 * (5.5 - was.x0) + p2 * (4.25 - was.y0));
      expect(editVolumes(g, 0, 100).volumes).toEqual(legacyEditVolumes(g, 0, 100));
    }
  });

  for (const s of SETS) {
    it(`on the ${s.name}: every pile, date and base, and every edited toe line`, async () => {
      const { read, vols, origin } = load(s);
      let n = 0;
      for (const pile of vols.piles) {
        const g = await decodePile(read(`${s.data}/piles/${pile.id}.js`));
        for (const [epoch, ep] of Object.entries(pile.epochs)) {
          for (const b of BASE_IDS) {
            const now = pileVolume(g, epoch, b);
            expect(now && { fill: now.fill, cut: now.cut, net: now.net }).toEqual(
              legacyPileVolume(g, epoch, b),
            );
            n++;
          }
          const dsm = await decodeDsm(read(`${s.data}/dsm_${epoch}.js`));
          const ring = ep.ring.map((q) => localToEN(origin, q));
          const surf = kitSurface(g, epoch, dsm);
          const geo = editGeometry(ring, surf);
          const was = legacyFits(ring, surf);
          expect(geo === null).toBe(was === null);
          if (!geo || !was) continue;
          expect([geo.low, geo.avg]).toEqual([was.low, was.avg]);
          expect(editVolumes(geo, dsm.x0, dsm.y1).volumes).toEqual(
            legacyEditVolumes(geo, dsm.x0, dsm.y1),
          );
        }
      }
      expect(n).toBeGreaterThan(0);
    }, 120_000);
  }
});

describe('the general engine on the kit grids', () => {
  for (const s of SETS) {
    it(`stays close to the kit on the ${s.name} (coverage weights, bases at the cell)`, async () => {
      const { read, vols, origin } = load(s);
      const last = vols.captures.at(-1)?.epoch ?? 'e2';
      const worst: Record<string, number> = {};
      for (const pile of vols.piles) {
        const g = await decodePile(read(`${s.data}/piles/${pile.id}.js`));
        const ep = pile.epochs[last];
        const surface = pileEngineSurface(g, last);
        if (!ep || !surface) continue;
        const ring = ep.ring.map((q) => localToEN(origin, q));
        const dsm = await decodeDsm(read(`${s.data}/dsm_${last}.js`));
        const geo = editGeometry(ring, kitSurface(g, last, dsm));
        if (!geo) continue;
        const kit = editVolumes(geo, dsm.x0, dsm.y1).volumes;
        const resolved: ResolvedSurface = {
          kind: 'grid',
          name: pile.id,
          fingerprint: `kit-${pile.id}-${last}`,
          grid: surface,
        };
        for (const [kitBase, base] of [
          ['plane', { kind: 'fit-plane' }],
          ['avg', { kind: 'perimeter-mean' }],
          ['low', { kind: 'reference', mode: 'perimeter-min' }],
          ['tin', { kind: 'smart' }],
        ] as [VolumeBaseId, SurfaceRef][]) {
          const r = await compareItem(
            ring,
            { id: 'k', from: base, to: { kind: 'survey', surface: pile.id }, useDeadband: false },
            () => Promise.resolve(resolved),
          );
          if (r.status === 'refused') continue;
          const k = kit[kitBase].net;
          if (Math.abs(k) < 100) continue;
          const d = Math.abs(r.netM3 - k) / Math.abs(k);
          worst[kitBase] = Math.max(worst[kitBase] ?? 0, d);
        }
      }
      // eslint-disable-next-line no-console -- the measured agreement, for the stream report
      console.info(`general engine against the kit (${s.name}):`, worst);
      // plane, avg and low differ by the sampling (perimeter every cell, not every 0.5 m, on the
      // pile grid alone) and the coverage weights. The kit's `tin` is a membrane pinned to the
      // ground outside the line, not the Delaunay `smart` base: up to about 20% apart, which is
      // why the volumetric workspace keeps the kit's own `tin` (see the G2 report).
      for (const [b, d] of Object.entries(worst))
        expect(d, b).toBeLessThan(b === 'tin' ? 0.25 : 0.03);
    }, 300_000);
  }
});
