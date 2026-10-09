import { defaultSurveySettings, type HeightTiles, type SurveySettings } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../shell', () => ({ bridge: { call } }));

const { refreshSiteTables, refreshSurface, siteTablesStale } = await import('./siteTables');

const DATA = { epsg: 32639 };
const settings = (patch: Partial<SurveySettings> = {}): SurveySettings => ({
  ...defaultSurveySettings(),
  ...patch,
});
const GRID = { file: 'geoid-site.f64' };

describe('siteTablesStale', () => {
  it('holds the tables made with the same calibration, CRS and datum', () => {
    expect(siteTablesStale({ to: DATA }, settings(), DATA)).toBeNull();
    const cal = settings({ calibration: 'cal-1', verticalDatum: { kind: 'calibration' } });
    expect(siteTablesStale({ calibration: 'cal-1', geoidGrid: GRID }, cal, DATA)).toBeNull();
    const geoid = settings({
      crs: { epsg: 2932 },
      verticalDatum: { kind: 'geoid', geoid: 'egm2008' },
    });
    expect(
      siteTablesStale({ to: { epsg: 2932 }, geoid: 'egm2008', geoidGrid: GRID }, geoid, DATA),
    ).toBeNull();
  });

  it('marks tables made before a calibration was applied, or after it was removed', () => {
    const applied = settings({ calibration: 'cal-1' });
    expect(siteTablesStale({ to: DATA }, applied, DATA)).toMatch(/calibration was applied/);
    expect(siteTablesStale({ calibration: 'cal-0', geoidGrid: GRID }, applied, DATA)).toMatch(
      /calibration was applied/,
    );
    expect(siteTablesStale({ calibration: 'cal-1', geoidGrid: GRID }, settings(), DATA)).toMatch(
      /calibration was removed/,
    );
  });

  it('marks a changed display CRS, geoid or vertical datum', () => {
    const qng = settings({ crs: { epsg: 2932 } });
    expect(siteTablesStale({ to: DATA }, qng, DATA)).toMatch(/coordinate system/);
    const geoid = settings({ verticalDatum: { kind: 'geoid', geoid: 'egm2008' } });
    expect(siteTablesStale({ to: DATA, geoid: 'egm96', geoidGrid: GRID }, geoid, DATA)).toMatch(
      /geoid/,
    );
    const ell = settings({ verticalDatum: { kind: 'ellipsoidal' } });
    expect(siteTablesStale({ to: DATA }, ell, DATA)).toMatch(/vertical datum/);
    expect(siteTablesStale({ to: DATA, geoidGrid: GRID }, settings(), DATA)).toMatch(
      /vertical datum/,
    );
  });
});

const tiles = (id: string, kind: 'dsm' | 'derived', capture?: string): HeightTiles =>
  ({
    schema: 'aio.height-tiles/1',
    id,
    name: id.toUpperCase(),
    source: kind === 'dsm' ? { kind, layer: `l-${id}` } : { kind, of: 'a', edits: [] },
    ...(capture ? { capture } : {}),
  }) as unknown as HeightTiles;

describe('refreshSiteTables', () => {
  beforeEach(() => {
    call.mockReset();
  });

  it('re-runs survey.prepare on one prepared DSM, so only the tables are written again', async () => {
    expect(refreshSurface([])).toBeNull();
    expect(refreshSurface([tiles('cut', 'derived'), tiles('dsm-c1', 'dsm', 'c1')])).toEqual({
      id: 'dsm-c1',
      name: 'DSM-C1',
      source: { kind: 'dsm', layer: 'l-dsm-c1' },
      capture: 'c1',
    });
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'survey:surfaces'
          ? { ok: true, value: { ok: true, surfaces: [tiles('dsm-c1', 'dsm', 'c1')] } }
          : { ok: true, value: { ok: true, job: { id: 'job-1' } } },
      ),
    );
    let listener: ((e: unknown) => void) | null = null;
    const off = vi.fn();
    vi.stubGlobal('window', {
      aio: {
        on: (_: string, fn: (e: unknown) => void) => {
          listener = fn;
          return off;
        },
      },
    });
    const done = vi.fn();
    expect(await refreshSiteTables({ id: 'p1', root: 'D:/p1' }, done)).toBeNull();
    expect(call).toHaveBeenLastCalledWith('jobs:start', {
      pipeline: 'survey.prepare',
      project: 'D:/p1',
      params: {
        surfaces: [
          {
            id: 'dsm-c1',
            name: 'DSM-C1',
            source: { kind: 'dsm', layer: 'l-dsm-c1' },
            capture: 'c1',
          },
        ],
      },
    });
    // the tables are read again when the job ends
    const emit = (status: string) => {
      listener?.({ type: 'update', job: { id: 'job-1', status } });
    };
    emit('running');
    expect(done).not.toHaveBeenCalled();
    emit('done');
    expect(done).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('starts nothing when no surface is prepared (there are no tables yet)', async () => {
    call.mockResolvedValue({ ok: true, value: { ok: true, surfaces: [] } });
    expect(await refreshSiteTables({ id: 'p1', root: 'D:/p1' }, vi.fn())).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
