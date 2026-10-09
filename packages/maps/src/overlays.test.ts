import type { Issue, PoseSample } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { frameProjection } from './geo';
import type { SeverityModel } from '@aio/schema';
import {
  footprint,
  headingLine,
  issueAnchor,
  overlayTiles,
  poseAt,
  rasterQuad,
  severityRankColors,
} from './overlays';
import { issueFeatures as featuresOf } from './vector';

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

describe('headingLine', () => {
  it('points from under the drone along the camera heading', () => {
    // heading east (yaw -90 deg about +Y), pitched down
    const yaw = -Math.PI / 4;
    const line = headingLine(
      { t: 0, pos: [10, 50, 20], q: [0, Math.sin(yaw), 0, Math.cos(yaw)] },
      30,
    );
    expect(line?.[0]).toEqual([10, 0, 20]);
    expect(line?.[1][0]).toBeCloseTo(40, 6);
    expect(line?.[1][2]).toBeCloseTo(20, 6);
  });

  it('has no direction looking straight down', () => {
    const s = Math.SQRT1_2;
    expect(headingLine({ t: 0, pos: [0, 50, 0], q: [-s, 0, 0, s] }, 30)).toBeNull();
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

const prop = (f: { properties: Record<string, unknown> | null }, k: string): unknown =>
  f.properties?.[k];

describe('issue features for the clustered map layer', () => {
  const model: SeverityModel = {
    id: 'road',
    name: 'Road',
    levels: [
      { value: 1, label: 'Low', color: '#111111', criteria: 'l' },
      { value: 2, label: 'Medium', color: '#222222', criteria: 'm' },
      { value: 3, label: 'High', color: '#333333', criteria: 'h' },
    ],
    uncertain: { label: 'Uncertain', color: '#999999' },
  };
  const mk = (id: string, severity: Issue['severity'], lon = 48): Issue => ({
    id,
    code: id.toUpperCase(),
    classId: 'c',
    severityModelId: 'road',
    severity,
    status: 'reviewed',
    title: 't',
    note: '',
    author: 'a',
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    source: 'import',
    sightings: [{ on: 'map', layer: 'o', geojson: { type: 'Point', coordinates: [lon, 29] } }],
  });
  const issues = [mk('a', 1), mk('b', 3, 48.1), mk('c', 'uncertain', 48.2)];
  const all = { show: true, minSeverity: null, heat: false };
  const issueFeatures = (
    list: Issue[],
    p: null,
    models: SeverityModel[],
    display: typeof all | { show: boolean; minSeverity: number | null; heat: boolean },
    focus: { selected: string | null; hover: string | null },
  ) =>
    featuresOf(list, {
      models,
      catalogues: [],
      selectedId: focus.selected,
      proj: p,
      display,
      hoverId: focus.hover,
    });

  it('colours each point from its severity model and ranks uncertain lowest', () => {
    const f = issueFeatures(issues, null, [model], all, { selected: null, hover: null });
    // lowest rank first, so the most severe draw on top
    expect(f.points.map((p) => [prop(p, 'code'), prop(p, 'sevColor'), prop(p, 'rank')])).toEqual([
      ['C', '#999999', -1],
      ['A', '#111111', 1],
      ['B', '#333333', 3],
    ]);
  });

  it('keeps the selected issue out of the clusters and labels it and the hovered one', () => {
    const f = issueFeatures(issues, null, [model], all, { selected: 'b', hover: 'a' });
    expect(f.points.map((p) => prop(p, 'code'))).toEqual(['C', 'A']);
    expect(f.focus.map((p) => [prop(p, 'code'), prop(p, 'selected')])).toEqual([
      ['A', false],
      ['B', true],
    ]);
  });

  it('applies the severity threshold and the off switch, but keeps the selection', () => {
    const min = issueFeatures(
      issues,
      null,
      [model],
      { ...all, minSeverity: 2 },
      { selected: null, hover: null },
    );
    expect(min.points.map((p) => prop(p, 'code'))).toEqual(['B']);
    const off = issueFeatures(
      issues,
      null,
      [model],
      { ...all, show: false },
      { selected: 'c', hover: null },
    );
    expect(off.points).toEqual([]);
    expect(off.focus.map((p) => prop(p, 'code'))).toEqual(['C']);
  });

  it('gives the heat layer every issue the threshold keeps, weighted by severity', () => {
    const f = issueFeatures(
      issues,
      null,
      [model],
      { ...all, show: false, heat: true },
      { selected: null, hover: null },
    );
    // uncertain, low, high
    expect(f.heat.map((p) => prop(p, 'weight'))).toEqual([
      expect.any(Number),
      expect.any(Number),
      1,
    ]);
    const w = f.heat.map((p) => Number(prop(p, 'weight')));
    expect(w[0]).toBeLessThan(w[1] ?? 0);
    expect(w[1]).toBeLessThan(w[2] ?? 0);
  });

  it('maps ranks to the worst colour for cluster badges', () => {
    expect(severityRankColors([model])).toEqual([
      [-1, '#999999'],
      [1, '#111111'],
      [2, '#222222'],
      [3, '#333333'],
    ]);
  });
});

describe('overlay pyramids (M11 G5)', () => {
  const index = {
    levels: [
      { z: 0, tileSize: 512, cols: 1, rows: 1, pattern: 'survey/overlays/s/0/{x}_{y}.webp' },
      { z: 1, tileSize: 512, cols: 2, rows: 2, pattern: 'survey/overlays/s/1/{x}_{y}.webp' },
      { z: 2, tileSize: 512, cols: 4, rows: 4, pattern: 'survey/overlays/s/2/{x}_{y}.webp' },
    ],
    corners: {
      tl: [-10, 0, -10] as [number, number, number],
      tr: [10, 0, -10] as [number, number, number],
      bl: [-10, 0, 10] as [number, number, number],
    },
  };
  it('shows the finest level within the tile budget, tiles covering the whole pyramid', () => {
    const all = overlayTiles(index);
    expect(all).toHaveLength(16);
    expect(all[0]?.path).toBe('survey/overlays/s/2/0_0.webp');
    expect(all[0]?.corners.tl).toEqual([-10, 0, -10]);
    expect(all[15]?.corners.bl).toEqual([5, 0, 10]);
    const few = overlayTiles(index, 4);
    expect(few.map((t) => t.z)).toEqual([1, 1, 1, 1]);
  });
});
