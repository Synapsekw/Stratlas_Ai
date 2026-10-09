// @vitest-environment jsdom
import type { HydroRun, ProjectManifest } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runs: HydroRun[] = [];
vi.mock('../shell', () => ({
  bridge: {
    call: (channel: string) =>
      Promise.resolve(
        channel === 'survey:surfaces'
          ? { ok: true, value: { ok: true, surfaces: [] } }
          : { ok: true, value: { ok: true, runs } },
      ),
  },
  jobs: { getState: () => ({ start: () => Promise.resolve(null) }) },
}));

const { hydro, loadHydro, newRunId, prepareParams } = await import('./hydroStore');
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
});
