import { describe, expect, it } from 'vitest';
import type { Layer } from '@aio/schema';
import { mockIssue, mockManifest, T0 } from '../__fixtures__/project';
import { buildDatasetTree } from './model';

describe('buildDatasetTree', () => {
  const tree = buildDatasetTree(
    mockManifest(),
    [mockIssue(), mockIssue({ id: 'i2', code: 'F02', status: 'draft' })],
    {
      dji0665: 11_000,
    },
  );

  it('groups layers by kind in a fixed order and skips empty groups', () => {
    expect(tree.map((g) => g.kind)).toEqual([
      'models',
      'pointclouds',
      'maps',
      'video',
      'photos',
      'panoramas',
      'annotations',
    ]);
  });

  it('counts layers, items and issues', () => {
    const count = Object.fromEntries(tree.map((g) => [g.kind, g.count]));
    expect(count).toEqual({
      models: 1,
      pointclouds: 1,
      maps: 2,
      video: 2,
      photos: 2,
      panoramas: 1,
      annotations: 2,
    });
  });

  it('adds a short meta per item', () => {
    const items = tree.flatMap((g) => g.items);
    const meta = Object.fromEntries(items.map((i) => [i.id, i.meta]));
    expect(meta.lidar).toBe('842 M');
    expect(meta.ortho).toBe('ortho');
    expect(meta.osm).toBe('offline');
    expect(meta.dji0665).toBe('0:11');
    expect(meta.dji0789).toBeUndefined();
    expect(meta.findings).toBe('2');
  });

  it('lists issues and drafts under annotations without visibility toggles', () => {
    const ann = tree.find((g) => g.kind === 'annotations');
    expect(ann?.items.map((i) => [i.id, i.meta, i.layerId])).toEqual([
      ['issues', '2', undefined],
      ['drafts', '1', undefined],
    ]);
  });

  it('marks layer rows with their layer id', () => {
    const video = tree.find((g) => g.kind === 'video');
    expect(video?.items.map((i) => i.layerId)).toEqual(['dji0665', 'dji0789']);
  });
});

describe('flights in the dataset tree', () => {
  const clip = (n: number): Layer => ({
    kind: 'video',
    id: `v${String(n)}`,
    name: `Flight 101 · Roof · clip ${String(n + 1)} of 2`,
    visible: true,
    src: { path: `video/v${String(n)}.mp4` },
    flight: { src: { path: 'flights/f101.json' }, startUtcMs: T0 },
    lens: { model: 'ftheta', hfovDeg: 114, aspect: 1.7778 },
    offsetMs: n * 60_000,
  });

  it('puts the clips of one flight under a flight row and still counts clips', () => {
    const tree = buildDatasetTree({ ...mockManifest(), layers: [clip(0), clip(1)] }, [], {
      v0: 60_000,
      v1: 24_000,
    });
    const video = tree.find((g) => g.kind === 'video');
    expect(video?.count).toBe(2);
    expect(video?.items).toEqual([
      {
        id: 'flight:flights/f101.json@' + String(T0),
        name: 'Flight 101 · Roof',
        meta: '1:24',
        children: [
          { id: 'v0', layerId: 'v0', layerKind: 'video', name: 'clip 1 of 2', meta: '1:00' },
          { id: 'v1', layerId: 'v1', layerKind: 'video', name: 'clip 2 of 2', meta: '0:24' },
        ],
      },
    ]);
  });
});
