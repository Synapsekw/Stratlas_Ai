import { fromWgs84 } from '@aio/geo';
import { LonLatRing, type ProjectManifest, type SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import type { CaptureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { areaScope, polygonRing, previousPair, type AreaManifest } from './areaModel';

const EPSG = 32639;
const E0 = 500000;
const N0 = 3200000;

function measurement(
  pts: [number, number][],
  over: Partial<SurveyMeasurement> = {},
): SurveyMeasurement {
  return {
    id: 'm1',
    family: 'polygon',
    tool: 'area',
    label: 'Pad A',
    scope: { kind: 'site' },
    points: pts.map(([e, n]) => [E0 + e, N0 + n, 10]),
    items: [],
    results: [],
    createdAt: '2026-10-01T00:00:00Z',
    ...over,
  };
}

/** A project in UTM 39N with two dates; `c2` carries `lineUp` (and `lineUpTurn`) when given. */
function site(
  over: Partial<Pick<ProjectManifest, 'crs'>> & {
    lineUp?: { eastM: number; northM: number };
    turn?: { rotationDeg: number; scale: number; pivotE: number; pivotN: number };
  } = {},
): AreaManifest {
  const c2 = {
    id: 'c2',
    label: 'April',
    date: '2026-04-01',
    ...(over.lineUp ? { lineUp: { ...over.lineUp, with: 'c1', at: '2026-10-01T00:00:00Z' } } : {}),
    ...(over.turn ? { lineUpTurn: over.turn } : {}),
  };
  return {
    crs: over.crs ?? { epsg: EPSG },
    origin: [E0, N0, 0],
    captures: [{ id: 'c1', label: 'March', date: '2026-03-01' }, c2],
    layers: [],
  };
}

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

/** The ring's corners back in the project CRS. */
function corners(r: ReturnType<typeof polygonRing>): [number, number][] {
  if (!('ring' in r)) throw new Error(`expected a ring, got ${r.reason}`);
  return r.ring.map(([lon, lat]) => {
    const [e, n] = fromWgs84([lon, lat, 0], EPSG);
    return [e - E0, n - N0];
  });
}

describe('polygonRing', () => {
  it('turns a square into a valid lon/lat ring that round-trips', () => {
    const r = polygonRing(measurement(square), site());
    if (!('ring' in r)) throw new Error('expected a ring');
    expect(r.ring).toHaveLength(4);
    expect(LonLatRing.safeParse(r.ring).success).toBe(true);
    corners(r).forEach(([e, n], i) => {
      expect(Math.abs(e - (square[i] ?? [0, 0])[0])).toBeLessThan(0.001);
      expect(Math.abs(n - (square[i] ?? [0, 0])[1])).toBeLessThan(0.001);
    });
  });

  it('places a survey polygon where its lined-up date draws it, shift and turn applied', () => {
    // 2.4 m east, 1.1 m south and a 0.5 degree turn about a pivot 20 m west of the square: far
    // past any margin around a change
    const turn = { rotationDeg: 0.5, scale: 1.001, pivotE: E0 - 20, pivotN: N0 };
    const m = measurement(square, { scope: { kind: 'survey', capture: 'c2' } });
    const got = corners(polygonRing(m, site({ lineUp: { eastM: 2.4, northM: -1.1 }, turn })));
    const a = 1.001 * Math.cos((0.5 * Math.PI) / 180);
    const b = 1.001 * Math.sin((0.5 * Math.PI) / 180);
    square.forEach(([e, n], i) => {
      const dE = e + 20;
      const want = [-20 + a * dE - b * n + 2.4, b * dE + a * n - 1.1];
      expect(Math.abs((got[i]?.[0] ?? 0) - (want[0] ?? 0))).toBeLessThan(0.001);
      expect(Math.abs((got[i]?.[1] ?? 0) - (want[1] ?? 0))).toBeLessThan(0.001);
    });
    // a site polygon never moves with a date
    const flat = corners(
      polygonRing(measurement(square), site({ lineUp: { eastM: 2.4, northM: 0 } })),
    );
    expect(Math.abs((flat[0]?.[0] ?? 1) - 0)).toBeLessThan(0.001);
  });

  it('refuses a line', () => {
    const r = polygonRing(measurement(square, { family: 'line', tool: 'distance' }), site());
    expect(r).toEqual({ reason: 'Only a polygon can be compared.' });
  });

  it('refuses a project placed by a WKT only, saying why', () => {
    expect(polygonRing(measurement(square), site({ crs: { wkt: 'PROJCS["x"]' } }))).toEqual({
      reason: t('actions.area.reason.noMap'),
    });
    expect(t('actions.area.reason.noMap')).toMatch(/EPSG/);
  });

  it('is refused with a reason, not an error, in a CRS this computer cannot convert', () => {
    expect(polygonRing(measurement(square), site({ crs: { epsg: 2056 } }))).toEqual({
      reason: t('actions.area.reason.unknownCrs', { epsg: 2056 }),
    });
  });

  it('does not count a repeated closing point', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [10, 0],
        [0, 0],
      ]),
      site(),
    );
    expect(r).toEqual({ reason: t('actions.area.reason.tooFew') });
  });

  it('drops a repeated closing point and a doubled vertex from the ring', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [10, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]),
      site(),
    );
    expect('ring' in r && r.ring.length).toBe(4);
  });

  it('keeps a vertex that comes back later in the outline', () => {
    // an outline pinched at (5, 5): dropping the second visit would hide the pinch
    const r = polygonRing(
      measurement([
        [0, 0],
        [10, 0],
        [5, 5],
        [10, 10],
        [0, 10],
        [5, 5],
      ]),
      site(),
    );
    expect(r).toEqual({ reason: t('actions.area.reason.crossing') });
  });

  it('refuses collinear points', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [5, 0],
        [10, 0],
      ]),
      site(),
    );
    expect(r).toEqual({ reason: t('actions.area.reason.zeroArea') });
  });

  it('refuses a bow-tie', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ]),
      site(),
    );
    expect(r).toEqual({ reason: t('actions.area.reason.crossing') });
  });

  it('checks a traced outline of thousands of points quickly, and only once', () => {
    const n = 4000;
    const pts: [number, number][] = Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return [50 * Math.cos(a), 50 * Math.sin(a)];
    });
    const m = measurement(pts);
    const t0 = performance.now();
    expect('ring' in polygonRing(m, site())).toBe(true);
    const first = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) polygonRing(m, site());
    expect(performance.now() - t1).toBeLessThan(Math.max(50, first));
  });
});

function index(ids: string[]): CaptureIndex {
  return {
    captures: ids.map((id) => ({ id, name: id })),
    layers: {},
    of: {},
    epochs: {},
    slot: {},
  } as unknown as CaptureIndex;
}

describe('previousPair', () => {
  const idx = index(['a', 'b', 'c']);
  const siteWide = measurement(square);
  const onSurvey = (capture: string) => measurement(square, { scope: { kind: 'survey', capture } });

  it('uses the survey the polygon is on', () => {
    expect(previousPair(idx, onSurvey('c'), null)).toEqual({ from: 'b', to: 'c' });
  });
  it('uses the focused survey for a site polygon', () => {
    expect(previousPair(idx, siteWide, 'b')).toEqual({ from: 'a', to: 'b' });
  });
  it('uses the latest survey when dates are off', () => {
    expect(previousPair(idx, siteWide, null)).toEqual({ from: 'b', to: 'c' });
  });
  it('uses the latest pair for a site polygon while the first survey is focused', () => {
    expect(previousPair(idx, siteWide, 'a')).toEqual({ from: 'b', to: 'c' });
  });
  it('has no earlier survey before the first', () => {
    expect(previousPair(idx, onSurvey('a'), null)).toEqual({
      reason: t('actions.area.reason.noEarlier'),
    });
  });
  it('does not guess a pair for a survey that is gone', () => {
    expect(previousPair(idx, onSurvey('gone'), null)).toEqual({
      reason: t('actions.area.reason.noEarlier'),
    });
  });
  it('has no earlier survey with one capture', () => {
    expect(previousPair(index(['a']), siteWide, null)).toEqual({
      reason: t('actions.area.reason.noEarlier'),
    });
  });
});

describe('areaScope', () => {
  it('falls back to the id for a blank label', () => {
    expect(areaScope(measurement(square, { label: '   ' })).name).toBe('m1');
  });
  it('keeps the id and cuts the name to 120', () => {
    const s = areaScope(measurement(square, { label: ` ${'x'.repeat(200)}` }));
    expect(s.id).toBe('m1');
    expect(s.name).toHaveLength(120);
  });
  it('never cuts a character in half', () => {
    const whole = (s: string) =>
      !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
    const cut = areaScope(measurement(square, { label: `${'x'.repeat(119)}😀😀` })).name;
    expect(cut).toBe('x'.repeat(119));
    expect(whole(cut)).toBe(true);
    const kept = areaScope(measurement(square, { label: `${'x'.repeat(118)}😀😀` })).name;
    expect(kept).toBe(`${'x'.repeat(118)}😀`);
    expect(kept.length).toBeLessThanOrEqual(120);
  });
});
