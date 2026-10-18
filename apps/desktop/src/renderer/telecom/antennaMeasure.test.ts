// @vitest-environment jsdom
import type { AntennaUnit, Vec3 } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { frameOf } from '../survey/measureScene';
import { antennaCorners, antennaMeasure } from './antennaMeasure';

vi.mock('../shell', () => ({ bridge: { call: () => Promise.resolve({ ok: false }) }, jobs: {} }));

// origin 0: project (E, N, Z) is local (E, Z, -N)
const frame = frameOf({ crs: {}, origin: [0, 0, 0] } as never);

const val = (value: number) => ({
  value,
  basis: 'measured' as const,
  quality: { basis: 'measured' as const },
});

function unit(over: Partial<AntennaUnit> = {}): AntennaUnit {
  return {
    id: 'ant-14',
    name: 'A14',
    kind: 'panel',
    kindBasis: 'geometry',
    status: 'draft',
    box: {
      centre: [10, 20, 30],
      axes: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      extents: [0.4, 2.6, 0.3],
    },
    support: 100,
    azimuthGridDeg: val(170),
    downtiltDeg: val(0.3),
    widthM: val(0.4),
    heightM: val(2.6),
    depthM: val(0.3),
    // true = grid + convergence (`trueAzimuth`): 170 - 0.9 = 169.1
    convergenceDeg: -0.9,
    photos: [],
    user: {},
    runId: 'run-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const len = ([a, b]: [Vec3, Vec3]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const span = (pts: Vec3[], i: 0 | 1 | 2) =>
  Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]));

describe('antennaCorners', () => {
  it('spans the extents of an axis-aligned unit, around its local centre', () => {
    const c = antennaCorners(unit(), frame, null);
    expect(c).toHaveLength(8);
    // axes E, N, Z map to local x, -z, y: width along x, height along -z, depth along y
    expect(span(c, 0)).toBeCloseTo(0.4, 9);
    expect(span(c, 2)).toBeCloseTo(2.6, 9);
    expect(span(c, 1)).toBeCloseTo(0.3, 9);
    const mean = ([0, 1, 2] as const).map((i) => c.reduce((s, p) => s + p[i], 0) / 8);
    expect(mean[0]).toBeCloseTo(10, 9);
    expect(mean[1]).toBeCloseTo(30, 9);
    expect(mean[2]).toBeCloseTo(-20, 9);
  });

  it('moves with the line-up shift', () => {
    const plain = antennaCorners(unit(), frame, null);
    const moved = antennaCorners(unit(), frame, { eastM: 2, northM: -1 });
    plain.forEach((q, i) => {
      const p = moved[i] ?? q;
      expect(p[0] - q[0]).toBeCloseTo(2, 9);
      expect(p[1] - q[1]).toBeCloseTo(0, 9);
      // one metre south is +z
      expect(p[2] - q[2]).toBeCloseTo(1, 9);
    });
  });
});

describe('antennaMeasure', () => {
  // an upright unit: across east, up project Z, outward south
  const upright = unit({
    box: {
      centre: [10, 20, 30],
      axes: [
        [1, 0, 0],
        [0, 0, 1],
        [0, -1, 0],
      ],
      extents: [0.4, 2.6, 0.3],
    },
  });

  it('gives width, height and depth dimension lines with their values', () => {
    const m = antennaMeasure(upright, frame, null);
    const dims = m.spots.filter((s) => s.kind === 'dim');
    expect(dims.map((s) => s.text)).toEqual(['0.40 m', '2.60 m', '0.30 m']);
    expect(m.spots.every((s) => s.selected)).toBe(true);
    // the height line is the long vertical one (ticks are 0.05 m)
    const vertical = m.segments.filter(([a, b]) => Math.abs(b[1] - a[1]) > 0.1);
    expect(vertical.map((v) => Math.abs(len(v) - 2.6) < 1e-6)).toEqual([true]);
    // three lines, each with two end ticks of 0.05 m
    expect(m.segments).toHaveLength(9);
    expect(m.segments.filter((s) => Math.abs(len(s) - 0.05) < 1e-9)).toHaveLength(6);
  });

  it('anchors each value at its line midpoint, off the box by the offset', () => {
    const m = antennaMeasure(upright, frame, null);
    const h = m.spots.find((s) => s.text === '2.60 m');
    // centre local (10, 30, -20); right-front edge at x 10.2, z -19.85, offset 0.08 outward (+z)
    expect(h?.at[0]).toBeCloseTo(10.2, 9);
    expect(h?.at[1]).toBeCloseTo(30, 9);
    expect(h?.at[2]).toBeCloseTo(-19.77, 9);
  });

  it('puts the true azimuth and downtilt at the facing-arrow tip', () => {
    const angles = antennaMeasure(upright, frame, null).spots.filter((s) => s.kind === 'angle');
    expect(angles.map((s) => s.text)).toEqual(['az 169.1° · tilt 0.3°']);
    // arrow length clamp(2.6, 0.5, 5) toward grid 170 (north is -z)
    const az = (170 * Math.PI) / 180;
    expect(angles[0]?.at[0]).toBeCloseTo(10 + Math.sin(az) * 2.6, 9);
    expect(angles[0]?.at[2]).toBeCloseTo(-20 - Math.cos(az) * 2.6, 9);
  });

  it('labels the name and height above the box top', () => {
    const m = antennaMeasure(upright, frame, null);
    const name = m.spots.filter((s) => s.kind === 'name');
    expect(name.map((s) => s.text)).toEqual(['A14 · 2.60 m']);
    expect(name[0]?.at[1]).toBeGreaterThan(30 + 1.3);
  });

  it('keeps the width label on top, depth below and the name above both', () => {
    const spots = antennaMeasure(upright, frame, null).spots;
    const width = spots.find((s) => s.text === '0.40 m');
    const depth = spots.find((s) => s.text === '0.30 m');
    const name = spots.find((s) => s.kind === 'name');
    // box centre local y 30, half height 1.3
    expect(width?.at[1]).toBeGreaterThan(30 + 1.3 - 1e-6);
    expect(depth?.at[1]).toBeLessThan(30);
    expect(name?.at[1]).toBeGreaterThan(width?.at[1] ?? Infinity);
  });

  it('has no angle spot without an azimuth', () => {
    const rest = { ...upright };
    delete rest.azimuthGridDeg;
    const m = antennaMeasure(rest, frame, null);
    expect(m.spots.filter((s) => s.kind === 'angle')).toHaveLength(0);
  });

  it('shows elevation for a dish', () => {
    const rest = { ...upright };
    delete rest.downtiltDeg;
    const dish = { ...rest, kind: 'dish', elevationDeg: val(1.5) } as AntennaUnit;
    const angle = antennaMeasure(dish, frame, null).spots.find((s) => s.kind === 'angle');
    expect(angle?.text).toBe('az 169.1° · elev 1.5°');
  });

  it('uses the grid azimuth without convergence', () => {
    const angle = antennaMeasure({ ...upright, convergenceDeg: null }, frame, null).spots.find(
      (s) => s.kind === 'angle',
    );
    expect(angle?.text).toBe('az 170.0° · tilt 0.3°');
  });

  it('follows the line-up shift', () => {
    const a = antennaMeasure(upright, frame, null);
    const b = antennaMeasure(upright, frame, { eastM: 2, northM: -1 });
    b.spots.forEach((s, i) => {
      expect(s.at[0] - (a.spots[i]?.at[0] ?? 0)).toBeCloseTo(2, 9);
      expect(s.at[2] - (a.spots[i]?.at[2] ?? 0)).toBeCloseTo(1, 9);
    });
  });
});
