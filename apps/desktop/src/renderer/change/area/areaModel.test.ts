import { fromWgs84 } from '@aio/geo';
import { LonLatRing, type SurveyMeasurement } from '@aio/schema';
import { t } from '@aio/ui';
import type { CaptureIndex } from '@aio/workspace';
import { describe, expect, it } from 'vitest';
import { areaScope, polygonRing, previousPair } from './areaModel';

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

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('polygonRing', () => {
  it('turns a square into a valid lon/lat ring that round-trips', () => {
    const r = polygonRing(measurement(square), EPSG);
    if (!('ring' in r)) throw new Error('expected a ring');
    expect(r.ring).toHaveLength(4);
    expect(LonLatRing.safeParse(r.ring).success).toBe(true);
    r.ring.forEach(([lon, lat], i) => {
      const [e, n] = fromWgs84([lon, lat, 0], EPSG);
      expect(Math.abs(e - (E0 + (square[i] ?? [0, 0])[0]))).toBeLessThan(0.001);
      expect(Math.abs(n - (N0 + (square[i] ?? [0, 0])[1]))).toBeLessThan(0.001);
    });
  });

  it('refuses a line', () => {
    const r = polygonRing(measurement(square, { family: 'line', tool: 'distance' }), EPSG);
    expect(r).toEqual({ reason: 'Only a polygon can be compared.' });
  });

  it('refuses a missing map position', () => {
    expect(polygonRing(measurement(square), null)).toEqual({
      reason: t('actions.area.reason.noMap'),
    });
  });

  it('does not count a repeated closing point', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [10, 0],
        [0, 0],
      ]),
      EPSG,
    );
    expect(r).toEqual({ reason: t('actions.area.reason.tooFew') });
  });

  it('drops a repeated closing point from the ring', () => {
    const r = polygonRing(measurement([...square, [0, 0]]), EPSG);
    expect('ring' in r && r.ring.length).toBe(4);
  });

  it('refuses collinear points', () => {
    const r = polygonRing(
      measurement([
        [0, 0],
        [5, 0],
        [10, 0],
      ]),
      EPSG,
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
      EPSG,
    );
    expect(r).toEqual({ reason: t('actions.area.reason.crossing') });
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
  const site = measurement(square);
  const onSurvey = (capture: string) => measurement(square, { scope: { kind: 'survey', capture } });

  it('uses the survey the polygon is on', () => {
    expect(previousPair(idx, onSurvey('c'), null)).toEqual({ from: 'b', to: 'c' });
  });
  it('uses the focused survey for a site polygon', () => {
    expect(previousPair(idx, site, 'b')).toEqual({ from: 'a', to: 'b' });
  });
  it('uses the latest survey when dates are off', () => {
    expect(previousPair(idx, site, null)).toEqual({ from: 'b', to: 'c' });
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
    expect(previousPair(index(['a']), site, null)).toEqual({
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
});
