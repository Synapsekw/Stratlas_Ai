import type { Issue, PoseSample } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import { footprint, issueAnchor, poseAt, rasterQuad } from './overlays';

const TANK_UTM: [number, number] = [245747.13, 3179641.87];
const TANK_LONLAT: [number, number] = [48.39709173227198, 28.719105268785743];
const proj = frameProjection({ epsg: 32639 }, [TANK_UTM[0], TANK_UTM[1], 0]);
if (!proj) throw new Error('projection');

describe('raster placement', () => {
  it('converts local corners to a MapLibre image quad (tl, tr, br, bl)', () => {
    const quad = rasterQuad({ tl: [-100, 0, -50], tr: [100, 0, -50], bl: [-100, 0, 50] }, proj);
    expect(quad).toHaveLength(4);
    const [tl, tr, br, bl] = quad;
    // North-up rectangle: top edge has the larger latitude, right edge the larger longitude.
    expect(tl[1]).toBeGreaterThan(bl[1]);
    expect(tr[0]).toBeGreaterThan(tl[0]);
    // UTM grid north is about 1.2 deg off true north here, so the quad is a parallelogram.
    expect(br[0]).toBeCloseTo(tr[0] + bl[0] - tl[0], 6);
    expect(br[1]).toBeCloseTo(tr[1] + bl[1] - tl[1], 6);
    // Its centre is the tank.
    expect((tl[0] + br[0]) / 2).toBeCloseTo(TANK_LONLAT[0], 5);
    expect((tl[1] + br[1]) / 2).toBeCloseTo(TANK_LONLAT[1], 5);
  });
});

describe('poses', () => {
  const samples: PoseSample[] = [
    { t: 0, pos: [0, 100, 0], q: [0, 0, 0, 1] },
    { t: 1000, pos: [10, 100, 0], q: [0, 0, 0, 1] },
  ];

  it('interpolates position between samples and clamps outside', () => {
    expect(poseAt(samples, 500)?.pos).toEqual([5, 100, 0]);
    expect(poseAt(samples, -10)?.pos).toEqual([0, 100, 0]);
    expect(poseAt(samples, 5000)?.pos).toEqual([10, 100, 0]);
    expect(poseAt([], 0)).toBeNull();
  });
});

describe('footprint', () => {
  it('projects a nadir pinhole camera to a ground rectangle', () => {
    // Camera 100 m up looking straight down: rotate -90 deg about X.
    const s = Math.SQRT1_2;
    const fp = footprint(
      { t: 0, pos: [0, 100, 0], q: [-s, 0, 0, s] },
      { model: 'pinhole', hfovDeg: 90, aspect: 2 },
    );
    expect(fp).toHaveLength(4);
    const xs = fp.map((p) => p[0]);
    const zs = fp.map((p) => p[2]);
    // hfov 90 deg at 100 m: half-width 100 m; vertical half 50 m.
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    expect(Math.min(...xs)).toBeCloseTo(-100, 6);
    expect(Math.max(...zs)).toBeCloseTo(50, 6);
    expect(Math.min(...zs)).toBeCloseTo(-50, 6);
    for (const p of fp) expect(p[1]).toBeCloseTo(0, 6);
  });

  it('caps rays that never reach the ground', () => {
    // Looking at the horizon (identity: looks along -Z, north).
    const fp = footprint(
      { t: 0, pos: [0, 100, 0], q: [0, 0, 0, 1] },
      { model: 'pinhole', hfovDeg: 60, aspect: 1.5 },
      { maxRange: 1000 },
    );
    for (const p of fp) expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(1000.0001);
  });
});

describe('issue anchors', () => {
  const base = {
    id: 'i1',
    code: 'F01',
    classId: 'crack',
    severityModelId: 'm',
    severity: 5,
    status: 'draft',
    title: 'Crack',
    note: '',
    author: 'a',
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    source: 'human',
  } satisfies Omit<Issue, 'sightings'>;

  it('uses a map sighting point directly', () => {
    const issue: Issue = {
      ...base,
      sightings: [{ on: 'map', layer: 'm', geojson: { type: 'Point', coordinates: [48.1, 29.2] } }],
    };
    expect(issueAnchor(issue, proj)).toEqual([48.1, 29.2]);
  });

  it('converts a mesh sighting from the local frame', () => {
    const issue: Issue = {
      ...base,
      sightings: [
        { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 10, 0], n: [0, 1, 0] } },
      ],
    };
    const a = issueAnchor(issue, proj);
    expect(a?.[0]).toBeCloseTo(TANK_LONLAT[0], 7);
    expect(a?.[1]).toBeCloseTo(TANK_LONLAT[1], 7);
  });

  it('returns null for image-only issues', () => {
    const issue: Issue = {
      ...base,
      sightings: [{ on: 'image', layer: 'p', photo: 'x', geom: { type: 'point', x: 1, y: 2 } }],
    };
    expect(issueAnchor(issue, proj)).toBeNull();
  });
});
