// @vitest-environment jsdom
import type { HeightTiles, HydroRun, ProjectManifest } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runs: HydroRun[] = [];
const started: { pipeline: string; project: string; params: Record<string, unknown> }[] = [];
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string) =>
      Promise.resolve(
        channel === 'survey:surfaces'
          ? { ok: true, value: { ok: true, surfaces: [] } }
          : { ok: true, value: { ok: true, runs } },
      ),
  },
  jobs: {
    getState: () => ({
      start: (req: (typeof started)[number]) => {
        started.push(req);
        return Promise.resolve(null);
      },
    }),
  },
}));

const {
  HYDRO_CELL_LIMITS,
  hydro,
  isCellLimitError,
  loadHydro,
  newRunId,
  prepareParams,
  regionNeed,
  runCells,
  startHydro,
  withRegion,
} = await import('./hydroStore');
const { workspace } = await import('@aio/workspace');
const { parsePoint, parsePoints } = await import('./HydroForms');
const { tabOf } = await import('./Hydro');

const run = (id: string, over: Partial<HydroRun> = {}): HydroRun =>
  ({
    schema: 'aio.hydro-run/1',
    id,
    pipeline: 'hydro.flow',
    jobId: id,
    computedAt: '2026-10-09T10:00:00Z',
    surface: { id: 's', name: 'S', fingerprint: 'f' },
    params: {},
    cellM: 1,
    results: { mode: 'runoff', method: 'd8', depressions: 'breach' },
    files: {},
    fingerprint: 'x',
    ...over,
  }) as HydroRun;

describe('hydrology in the renderer (G10)', () => {
  beforeEach(() => {
    runs.length = 0;
    hydro.setState({ projectId: null, pending: null, selected: null });
  });

  it('reads points typed as E, N', () => {
    expect(parsePoint('551200.5, 2331349')).toEqual([551200.5, 2331349]);
    expect(parsePoint('551200.5 2331349')).toEqual([551200.5, 2331349]);
    expect(parsePoint('551200.5')).toBeNull();
    expect(parsePoint('a, b')).toBeNull();
    expect(parsePoints('1, 2\n\n3, 4\n')).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(parsePoints('1, 2\nx')).toBeNull();
  });

  it('names runs by kind and time and prepares every DSM once', () => {
    expect(newRunId('flood', new Date(2026, 9, 9, 7, 5, 3))).toBe('flood-20261009-070503');
    const manifest = {
      layers: [
        { id: 'dsm-1', kind: 'raster', role: 'dsm', capture: 'm1', name: 'DSM January' },
        { id: 'ortho-1', kind: 'raster', role: 'ortho', capture: 'm1', name: 'Ortho' },
        { id: 'dsm-x', kind: 'raster', role: 'dsm', name: 'DSM' },
      ],
    } as unknown as ProjectManifest;
    expect(prepareParams(manifest)).toEqual({
      surfaces: [
        {
          id: 'dsm-m1',
          name: 'DSM January',
          source: { kind: 'dsm', layer: 'dsm-1' },
          capture: 'm1',
        },
        { id: 'dsm-dsm-x', name: 'DSM', source: { kind: 'dsm', layer: 'dsm-x' } },
      ],
    });
    expect(prepareParams({ layers: [] } as unknown as ProjectManifest)).toBeNull();
  });

  it('shows a run started from the panel once it is listed', async () => {
    hydro.setState({ projectId: 'p', pending: 'runoff-1' });
    await loadHydro('p');
    expect(hydro.getState().pending).toBe('runoff-1');
    runs.push(run('runoff-1'));
    await loadHydro('p');
    expect(hydro.getState()).toMatchObject({ pending: null, selected: 'runoff-1' });
    expect(tabOf(run('a'))).toBe('runoff');
    expect(
      tabOf(run('b', { results: { mode: 'catchment', method: 'd8', depressions: 'fill' } })),
    ).toBe('catchment');
  });

  it('counts the cells a run reads and asks for a region above the limit', () => {
    // 4 km by 3 km at 0.5 m: 8000 by 6000 = 48 million cells
    const s: Pick<HeightTiles, 'bounds' | 'cellM' | 'originE' | 'originN'> = {
      bounds: [0, 0, 0, 4000, 3000, 10],
      cellM: 0.5,
      originE: 0,
      originN: 0,
    };
    expect(runCells(s, null)).toEqual({ cols: 8000, rows: 6000, cellM: 0.5 });
    expect(regionNeed('hydro.flood', s, null)).toMatch(
      /^The surface is 8,000 by 6,000 cells at 0.5 m; Flood to level takes at most 25,000,000 cells\. Pick or draw a region/,
    );
    // a 1 km square region: 2000 by 2000 = 4 million, at the runoff limit exactly
    const square: [number, number][] = [
      [1000, 1000],
      [2000, 1000],
      [2000, 2000],
      [1000, 2000],
    ];
    expect(runCells(s, square)).toEqual({ cols: 2000, rows: 2000, cellM: 0.5 });
    expect(regionNeed('hydro.flow', s, square)).toBeNull();
    expect(regionNeed('hydro.flood', s, square)).toBeNull();
    // rainfall resamples to its own cell: the whole site at 2 m is 2000 by 1500 = 3 million
    expect(regionNeed('hydro.rainfall', s, null, 2)).toBeNull();
    expect(regionNeed('hydro.rainfall', s, null, 1)).toMatch(
      /Direct rainfall takes at most 4,000,000/,
    );
    // a region beyond the surface
    const away: [number, number][] = [
      [5000, 5000],
      [6000, 5000],
      [6000, 6000],
    ];
    expect(runCells(s, away)).toBeNull();
    expect(regionNeed('hydro.flow', s, away)).toMatch(/does not overlap/);
    expect(regionNeed('hydro.flow', undefined, null)).toBeNull();
    expect(HYDRO_CELL_LIMITS['hydro.flow']).toBe(4_000_000);
  });

  it('sends the region with the run, and knows the pipeline refusal', async () => {
    const square: [number, number][] = [
      [1, 1],
      [2, 1],
      [2, 2],
    ];
    expect(withRegion({ surface: 's' }, square)).toEqual({ surface: 's', region: square });
    expect(withRegion({ surface: 's' }, null)).toEqual({ surface: 's' });
    workspace.setState({ project: { id: 'p', root: 'C:/projects/p' } } as unknown as Parameters<
      typeof workspace.setState
    >[0]);
    started.length = 0;
    expect(
      await startHydro(
        'hydro.flood',
        withRegion({ surface: 's', levelM: 3, mode: 'all-below' }, square),
        'flood',
      ),
    ).toBeNull();
    expect(started[0]).toMatchObject({
      pipeline: 'hydro.flood',
      project: 'C:/projects/p',
      params: { surface: 's', levelM: 3, mode: 'all-below', region: square },
    });
    expect(
      isCellLimitError(
        'The area is 8,000 by 6,000 cells at 0.5 m; this tool takes at most 4,000,000 cells (about 1,000 by 1,000 m at this cell). Draw a region around the area of interest.',
      ),
    ).toBe(true);
    expect(isCellLimitError('The surface has no data.')).toBe(false);
    expect(isCellLimitError(null)).toBe(false);
  });
});
