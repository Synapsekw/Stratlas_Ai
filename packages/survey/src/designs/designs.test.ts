import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Alignment, ComparisonItem } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  alignmentPolyline,
  distanceAt,
  formatStation,
  pointAt,
  pointAtStation,
  stationAt,
  stationLabels,
  stationOffset,
  stationRegions,
} from './alignment';
import {
  designComparisonItem,
  toleranceBand,
  toleranceHeatmap,
  toleranceShare,
} from './compliance';
import { parseTin, TinError, TinSampler } from './tin';

// The same fixtures as python/tests/test_design_import.py (the truth is scipy's Fresnel integral).
const FIX = join(import.meta.dirname, '__fixtures__');
interface Truth {
  distance: number;
  station: number;
  region: number;
  offset: number;
  e: number;
  n: number;
  bearing: number;
}
const shared = JSON.parse(readFileSync(join(FIX, 'alignment-clothoid.json'), 'utf8')) as {
  alignment: unknown;
  truth: Truth[];
};
const al = Alignment.parse(shared.alignment);
const E0 = 520010;
const N0 = 2750010;

describe('aio.alignment/1 arithmetic', () => {
  it('puts stations at the Fresnel truth within 1e-6 m', () => {
    for (const t of shared.truth.filter((x) => x.offset === 0)) {
      const p = pointAtStation(al, t.station, t.region);
      expect(p).not.toBeNull();
      const [e, n, b] = p ?? [0, 0, 0];
      expect(Math.abs(e - t.e)).toBeLessThan(1e-6);
      expect(Math.abs(n - t.n)).toBeLessThan(1e-6);
      expect(Math.abs(b - t.bearing)).toBeLessThan(1e-9);
    }
  });

  it('finds station and offset of known points within 1 mm', () => {
    for (const t of shared.truth) {
      const so = stationOffset(al, t.e, t.n);
      expect(so).not.toBeNull();
      expect(Math.abs((so?.station ?? 0) - t.station)).toBeLessThan(0.001);
      expect(Math.abs((so?.offset ?? 0) - t.offset)).toBeLessThan(0.001);
      expect(so?.region).toBe(t.region);
    }
  });

  it('inverts the clothoid on a dense walk', () => {
    for (let s = 100.5; s < 160; s += 59 / 24) {
      const [e, n, b] = pointAt(al, s);
      const so = stationOffset(al, e + 2.5 * Math.cos(b), n - 2.5 * Math.sin(b));
      expect(Math.abs((so?.distance ?? 0) - s)).toBeLessThan(1e-6);
      expect(Math.abs((so?.offset ?? 0) - 2.5)).toBeLessThan(1e-6);
    }
  });

  it('follows the station equation and labels like the Python core', () => {
    expect(stationAt(al, 149)).toEqual([1149, 0]);
    expect(stationAt(al, 150)).toEqual([2000, 1]);
    expect(distanceAt(al, 2060)).toBe(210);
    expect(distanceAt(al, 1160)).toBeNull();
    expect(stationLabels(al, 50).map((l) => l.label)).toEqual([
      '1+000',
      '1+050',
      '1+100',
      '1+150',
      '2+000',
      '2+050',
    ]);
    expect(formatStation(1234.5678)).toBe('1+234.568');
    expect(formatStation(-12.3, 2)).toBe('-0+012.30');
    expect(() => stationRegions({ ...al, equations: [{ back: 5000, ahead: 6000 }] })).toThrow(
      /outside the alignment/,
    );
  });

  it('gives no station off the ends and draws the alignment through every element end', () => {
    const [e0, n0] = al.elements[0]?.start ?? [0, 0];
    expect(stationOffset(al, e0, n0 - 10)).toBeNull();
    const line = alignmentPolyline(al, 5);
    expect(line[0]).toEqual([e0, n0]);
    const last = line[line.length - 1] ?? [0, 0];
    const end = al.elements[2]?.end ?? [0, 0];
    expect(Math.hypot(last[0] - end[0], last[1] - end[1])).toBeLessThan(1e-6);
  });
});

describe('aio.tin/1 reader', () => {
  const bytes = new Uint8Array(readFileSync(join(FIX, 'pad.tin')));

  it('reads the fixture the Python writer made', () => {
    const tin = parseTin(bytes);
    expect(tin.header.vertexCount).toBe(9);
    expect(tin.header.triangleCount).toBe(8);
    expect(tin.header.crs).toEqual({ epsg: 32639 });
    expect([...tin.vertices.slice(12, 15)]).toEqual([E0 + 10, N0 + 10, 101.75]);
    expect([...tin.triangles.slice(0, 3)]).toEqual([0, 1, 4]);
    expect(tin.chains).toHaveLength(1);
    expect(tin.chains[0]?.kind).toBe(0);
    expect([...(tin.chains[0]?.indices ?? [])]).toEqual([3, 4, 5]);
  });

  it('moves every vertex by the vertical offset exactly', () => {
    const plain = parseTin(bytes);
    const moved = parseTin(bytes, -0.3);
    for (let i = 0; i < plain.vertices.length; i++) {
      const want = i % 3 === 2 ? (plain.vertices[i] ?? 0) - 0.3 : plain.vertices[i];
      expect(moved.vertices[i]).toBe(want);
    }
  });

  it('samples heights by barycentric interpolation', () => {
    const tin = parseTin(bytes);
    const s = new TinSampler(tin);
    expect(s.sample(E0 + 10, N0 + 10)).toBeCloseTo(101.75, 9);
    expect(s.sample(E0, N0)).toBeCloseTo(100, 9);
    // the centroid of the first triangle (0, 1, 4): mean of 100, 100.5 and 101.75
    expect(s.sample(E0 + 20 / 3, N0 + 10 / 3)).toBeCloseTo((100 + 100.5 + 101.75) / 3, 9);
    expect(s.sample(E0 - 1, N0)).toBeNull();
    expect(new TinSampler(tin, -0.3).sample(E0 + 10, N0 + 10)).toBeCloseTo(101.45, 9);
  });

  it('refuses a damaged file', () => {
    expect(() => parseTin(bytes.slice(0, bytes.length - 10))).toThrow(TinError);
    expect(() => parseTin(new Uint8Array(2))).toThrow(/empty or damaged/);
  });
});

describe('compliance to design', () => {
  it('reports the in-tolerance share of a seeded error band', () => {
    // 100 cells of 0.25 m2: 70 within 50 mm, 20 above the design (cut), 8 below (fill), 2 holes
    const dz = new Float64Array(100);
    for (let i = 0; i < 100; i++) dz[i] = ((i % 7) - 3) * 0.01;
    for (let i = 70; i < 90; i++) dz[i] = -0.2;
    for (let i = 90; i < 98; i++) dz[i] = 0.08;
    dz[98] = Number.NaN;
    dz[99] = Number.NaN;
    const r = toleranceShare(dz, 0.05, 0.25);
    expect(r.inToleranceM2).toBeCloseTo(17.5, 12);
    expect(r.cutM2).toBeCloseTo(5, 12);
    expect(r.fillM2).toBeCloseTo(2, 12);
    expect(r.uncoveredM2).toBeCloseTo(0.5, 12);
    expect(r.share).toBeCloseTo(17.5 / 24.5, 12);
    // coverage weights at a polygon edge
    const half = toleranceShare([0, 0.2], 0.05, 1, [0.5, 1]);
    expect(half.share).toBeCloseTo(0.5 / 1.5, 12);
  });

  it('bands plus and minus the tolerance', () => {
    expect(toleranceBand(0.05, 0.05)).toBe('in');
    expect(toleranceBand(-0.0501, 0.05)).toBe('cut');
    expect(toleranceBand(0.06, 0.05)).toBe('fill');
    expect(toleranceBand(Number.NaN, 0.05)).toBeNull();
    const h = toleranceHeatmap(0.05);
    expect(h.stops.map((s) => s.value)).toEqual([-0.1, -0.05, 0.05]);
    expect(h.stepped).toBe(true);
    expect(() => toleranceHeatmap(0)).toThrow(RangeError);
  });

  it('makes the two design presets as valid comparison items', () => {
    const opts = { id: 'c1', design: 'pad', layer: 'Pad-design', toleranceM: 0.05 };
    const cf = ComparisonItem.parse(designComparisonItem('cut-fill-to-design', opts));
    expect(cf).toMatchObject({ from: { kind: 'current' }, useDeadband: false, deadbandM: 0.05 });
    expect(cf.to).toEqual({ kind: 'design', design: 'pad', layer: 'Pad-design' });
    const rem = ComparisonItem.parse(designComparisonItem('remaining-to-design', opts));
    expect(rem).toMatchObject({ deadbandM: 0.05, useDeadband: true, label: 'Remaining to design' });
  });
});
