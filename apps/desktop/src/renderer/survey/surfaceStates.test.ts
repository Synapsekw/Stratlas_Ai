import type { HeightTiles, JobRecord, ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({
  jobs: { getState: () => ({ jobs: [] }), subscribe: () => vi.fn() },
}));

const { surfaceStates } = await import('./surfaceStates');

const manifest = {
  captures: [
    { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
    { id: 'd2', label: 'Survey 6 April 2026', date: '2026-04-06' },
    { id: 'd3', label: 'Survey 4 May 2026', date: '2026-05-04' },
    { id: 'd4', label: 'Survey 1 June 2026', date: '2026-06-01' },
  ],
  layers: [
    { kind: 'raster', id: 'dsm-d1', role: 'dsm', capture: 'd1', name: 'DSM 1' },
    { kind: 'raster', id: 'dsm-d2', role: 'dsm', capture: 'd2', name: 'DSM 2' },
    { kind: 'pointcloud', id: 'pc-d3', capture: 'd3', name: 'Cloud 3' },
    { kind: 'raster', id: 'ortho-d4', role: 'ortho', capture: 'd4', name: 'Ortho 4' },
  ],
} as unknown as Pick<ProjectManifest, 'captures' | 'layers'>;

const prepared = [
  { id: 'dsm-d1', capture: 'd1', source: { kind: 'dsm', layer: 'dsm-d1' } },
] as unknown as HeightTiles[];

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'j1',
  pipeline: 'survey.prepare',
  project: 'C:/p',
  params: {},
  status: 'running',
  progress: 0.624,
  steps: [],
  artifacts: [],
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('surfaceStates', () => {
  it('names each date ready, missing or none', () => {
    const s = surfaceStates(manifest, prepared, []);
    expect(s.get('d1')).toEqual({ kind: 'ready' });
    expect(s.get('d2')).toEqual({ kind: 'missing' });
    // a point cloud is enough to prepare a surface from
    expect(s.get('d3')).toEqual({ kind: 'missing' });
    // neither a DSM nor a cloud
    expect(s.get('d4')).toEqual({ kind: 'none' });
  });

  it("is preparing with the job's progress as a whole percentage for the dates in its params", () => {
    const running = job({
      params: {
        surfaces: [
          { id: 'dsm-d2', name: 'x', source: { kind: 'dsm', layer: 'dsm-d2' }, capture: 'd2' },
          // no capture on the surface: the source layer's date
          { id: 'pc-d3', name: 'y', source: { kind: 'cloud', layer: 'pc-d3' } },
        ],
      },
    });
    const s = surfaceStates(manifest, prepared, [running]);
    expect(s.get('d2')).toEqual({ kind: 'preparing', pct: 62 });
    expect(s.get('d3')).toEqual({ kind: 'preparing', pct: 62 });
    expect(s.get('d1')).toEqual({ kind: 'ready' });
  });

  it('ignores ended jobs and other pipelines', () => {
    const params = {
      surfaces: [{ id: 'a', name: 'a', source: { kind: 'dsm', layer: 'dsm-d2' }, capture: 'd2' }],
    };
    const s = surfaceStates(manifest, prepared, [
      job({ status: 'cancelled', params }),
      job({ id: 'j2', pipeline: 'survey.qa', params }),
    ]);
    expect(s.get('d2')).toEqual({ kind: 'missing' });
  });

  it('reads a date with a kit DSM grid as missing, then preparing while the app converts it', () => {
    const s = surfaceStates(manifest, prepared, [], { dates: ['d4'], preparing: [] });
    expect(s.get('d4')).toEqual({ kind: 'missing' });
    const p = surfaceStates(manifest, prepared, [], { dates: ['d4'], preparing: ['d4'] });
    expect(p.get('d4')).toEqual({ kind: 'preparing', pct: 0 });
    // ready wins once its surface is listed
    const kit = { id: 'kit-dsm-e4', capture: 'd4', source: { kind: 'kit-dsm', epoch: 'e4' } };
    const r = surfaceStates(manifest, [...prepared, kit] as unknown as HeightTiles[], [], {
      dates: ['d4'],
      preparing: ['d4'],
    });
    expect(r.get('d4')).toEqual({ kind: 'ready' });
  });
});
