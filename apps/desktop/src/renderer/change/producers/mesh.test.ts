import type { ChangePairContext } from '@aio/change';
import {
  DEFAULT_CHANGE_THRESHOLDS,
  pipelineParams,
  type Layer,
  type ProjectManifest,
} from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';
import { meshChangeProducer, meshJob, meshPair } from './mesh';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const model = (id: string, name: string, extra: Partial<Layer> = {}): Layer =>
  ({
    kind: 'mesh',
    id,
    name,
    visible: true,
    src: { path: `models/${id}.glb` },
    transform: IDENTITY,
    ...extra,
  }) as Layer;

const ctx = (layersFrom: Layer[], layersTo: Layer[]): ChangePairContext => ({
  projectId: 'p',
  manifest: { id: 'p', layers: [...layersFrom, ...layersTo] } as unknown as ProjectManifest,
  from: 'c1',
  to: 'c2',
  layersFrom,
  layersTo,
});

describe('model change', () => {
  it('pairs the model of each date, leaving deviation models out', () => {
    const r = meshPair(
      ctx(
        [model('e1', 'Site 10 Jan')],
        [
          model('e2', 'Site 10 Feb'),
          model('dev', 'Model change', { derived: { kind: 'change', from: 'c1', to: 'c2' } }),
        ],
      ),
    );
    expect(r).toMatchObject({ from: { id: 'e1' }, to: { id: 'e2' } });
    expect(meshPair(ctx([], [model('e2', 'Site')]))).toMatch(/3D model/);
  });

  it('builds a change.mesh job the contract accepts', () => {
    const job = meshJob(
      ctx([model('e1', 'A')], [model('e2', 'B')]),
      'E:/p',
      DEFAULT_CHANGE_THRESHOLDS,
    );
    if (typeof job === 'string') throw new Error(job);
    expect(job).toEqual({
      pipeline: 'change.mesh',
      project: 'E:/p',
      params: {
        layerFrom: 'e1',
        layerTo: 'e2',
        captures: { from: 'c1', to: 'c2' },
        minDistM: 0.05,
        maxDistM: 0.3,
      },
    });
    expect(pipelineParams('change.mesh').safeParse(job.params).success).toBe(true);
  });

  it('is a producer of component changes', async () => {
    const start = vi.fn(() => Promise.resolve({ jobId: 'j' }));
    const p = meshChangeProducer({
      projectRoot: () => 'E:/p',
      thresholds: () => DEFAULT_CHANGE_THRESHOLDS,
      start,
    });
    expect(p).toMatchObject({ id: 'mesh', label: 'Run model change', kinds: ['component'] });
    const c = ctx([model('e1', 'A')], [model('e2', 'B')]);
    expect(p.available(c)).toBe(true);
    await expect(p.run(c)).resolves.toEqual({ ok: true, jobId: 'j' });
  });
});
