import type { Layer, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { snapshotTransform } from './snapshots';

const mesh = (id: string, capture: string): Extract<Layer, { kind: 'mesh' }> => ({
  kind: 'mesh',
  id,
  name: id,
  visible: true,
  capture,
  src: { path: `models/${id}.glb` },
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 5, 1],
});

describe('report 3D views', () => {
  it('draw a model of a lined-up date where the 3D view has it', () => {
    const manifest = {
      captures: [
        { id: 'jan', label: 'January', date: '2026-01-01' },
        {
          id: 'jun',
          label: 'June',
          date: '2026-06-01',
          lineUp: { eastM: 2, northM: 1, with: 'jan', at: '2026-10-16T08:00:00Z' },
        },
      ],
      layers: [mesh('jan-model', 'jan'), mesh('jun-model', 'jun')],
    } as unknown as ProjectManifest;
    const [jan, jun] = manifest.layers as Extract<Layer, { kind: 'mesh' }>[];
    if (!jan || !jun) throw new Error('fixture');
    expect(snapshotTransform(manifest, jan).slice(12, 15)).toEqual([5, 0, 5]);
    expect(snapshotTransform(manifest, jun).slice(12, 15)).toEqual([7, 0, 4]);
  });
});
