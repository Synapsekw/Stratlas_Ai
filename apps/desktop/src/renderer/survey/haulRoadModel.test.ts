import { HaulRun, type HeightTiles } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildHaulParams,
  failedChecks,
  HAUL_DEFAULTS,
  haulDefaults,
  minBermHeight,
  newRunId,
  piecesOf,
  staleReason,
  stationCells,
} from './haulRoadModel';

const run = HaulRun.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../../../packages/schema/src/__fixtures__/haul/run.json', import.meta.url),
      ),
      'utf8',
    ),
  ),
);

const limits = {
  minWidthM: '20',
  maxGradePct: '10',
  crossFallMinPct: '1',
  crossFallMaxPct: '4',
  minBermHeightM: '1',
};

describe('haul-road model (G11)', () => {
  it('reads the site defaults from the loose haul key, over the built-in ones', () => {
    expect(haulDefaults({ schema: 'aio.survey-settings/1' })).toEqual(HAUL_DEFAULTS);
    expect(
      haulDefaults({
        haul: { intervalM: 25, limits: { maxGradePct: 8, bogus: 1 }, wheelHeightM: 3.2 },
      }),
    ).toEqual({ intervalM: 25, limits: { maxGradePct: 8 }, wheelHeightM: 3.2, wheelShare: 0.5 });
    expect(haulDefaults({ haul: { intervalM: -1, limits: 'x', wheelShare: 9 } })).toEqual(
      HAUL_DEFAULTS,
    );
  });

  it('sets the minimum berm height from the largest wheel', () => {
    expect(minBermHeight(3.0)).toBe(1.5);
    expect(minBermHeight(2.4, 0.75)).toBe(1.8);
    expect(() => minBermHeight(0)).toThrow();
  });

  it('builds checked parameters from the panel fields', () => {
    const ok = buildHaulParams({
      surface: 'dsm-m3',
      centreline: { kind: 'design', design: 'haul-road', layer: 'road-cl' },
      intervalM: '10',
      limits: { ...limits, minWidthM: ' ' },
      run: 'haul-1',
    });
    expect(ok).toEqual({
      ok: true,
      params: {
        surface: 'dsm-m3',
        centreline: { design: 'haul-road', layer: 'road-cl' },
        intervalM: 10,
        limits: { maxGradePct: 10, crossFallMinPct: 1, crossFallMaxPct: 4, minBermHeightM: 1 },
        run: 'haul-1',
      },
    });
    const drawn = buildHaulParams({
      surface: 's',
      centreline: {
        kind: 'drawn',
        points: [
          [1, 2, 3],
          [4, 5, 6],
        ],
      },
      intervalM: '5',
      limits: {},
    });
    expect(drawn.ok && drawn.params.centreline).toEqual([
      [1, 2],
      [4, 5],
    ]);
    const base = { surface: 's', centreline: drawn.ok ? null : null, intervalM: '10', limits };
    expect(buildHaulParams(base)).toEqual({ ok: false, error: 'Pick a centreline.' });
    const cl = { kind: 'design', design: 'd', layer: 'l' } as const;
    expect(buildHaulParams({ ...base, centreline: cl, intervalM: '0' }).ok).toBe(false);
    expect(buildHaulParams({ ...base, centreline: cl, limits: { maxGradePct: 'steep' } })).toEqual({
      ok: false,
      error: 'Maximum grade (%) must be a number.',
    });
    const negative = buildHaulParams({ ...base, centreline: cl, limits: { minBermHeightM: '-1' } });
    expect(negative.ok || negative.error).toContain('Minimum berm height (m)');
    expect(
      buildHaulParams({
        ...base,
        centreline: cl,
        limits: { crossFallMinPct: '4', crossFallMaxPct: '1' },
      }).ok,
    ).toBe(false);
    expect(buildHaulParams({ ...base, surface: '', centreline: cl }).ok).toBe(false);
  });

  it('names runs by time and tells when a run is stale', () => {
    expect(newRunId(new Date('2026-10-09T10:11:12.345Z'))).toBe('haul-20261009T101112Z');
    const surface = { id: run.surface.id, fingerprint: run.surface.fingerprint } as HeightTiles;
    expect(staleReason(run, null)).toBeNull();
    expect(staleReason(run, [surface])).toBeNull();
    expect(staleReason(run, [{ ...surface, fingerprint: 'sha256:other' }])).toContain('changed');
    expect(staleReason(run, [])).toContain('no longer prepared');
  });

  it('formats a station and lists what failed', () => {
    const st = run.stations[0];
    if (!st) throw new Error('fixture');
    expect(stationCells(st)).toMatchObject({ width: '20.00', bermRight: 'none' });
    expect(failedChecks(st)).toEqual(['Right berm']);
  });

  it('reads the coloured centreline pieces of the GeoJSON', () => {
    const gj = {
      type: 'FeatureCollection',
      features: [
        {
          properties: { kind: 'centreline', station: '0+000.000', status: 'fail' },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0, 5],
              [1, 0],
            ],
          },
        },
        { properties: { kind: 'section' }, geometry: { type: 'LineString', coordinates: [] } },
        { properties: { kind: 'centreline' }, geometry: { type: 'Point', coordinates: [0, 0] } },
      ],
    };
    const [piece, ...rest] = piecesOf(gj, run);
    expect(rest).toEqual([]);
    expect(piece?.color).toBe('#e5484d');
    expect(piece?.points[1]?.[2]).toBe(
      run.stations.find((s) => s.stationLabel === '0+000.000')?.z ?? 0,
    );
    expect(piecesOf(null, run)).toEqual([]);
  });
});
