import type { BaseSpec, HeightTiles, ProjectManifest } from '@aio/schema';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const { levelVertices, moveVertices } = await import('./BaseEditor');
const { prepareParams } = await import('./compareStore');

type Custom = Extract<BaseSpec, { kind: 'custom' }>;

describe('custom base edits', () => {
  const base: Custom = {
    kind: 'custom',
    vertices: [
      { e: 0, n: 0, z: 10 },
      { e: 10, n: 0, offsetM: -0.5 },
      { e: 10, n: 10, z: 12 },
    ],
  };

  it('moves the selected vertices: a level by its level, an offset by its offset', () => {
    const moved = moveVertices(base, new Set([0, 1]), 0.25);
    expect(moved.vertices).toEqual([
      { e: 0, n: 0, z: 10.25 },
      { e: 10, n: 0, offsetM: -0.25 },
      { e: 10, n: 10, z: 12 },
    ]);
  });

  it('sets the selected vertices to one level (offsets become levels)', () => {
    const set = levelVertices(base, new Set([1, 2]), 9);
    expect(set.vertices).toEqual([
      { e: 0, n: 0, z: 10 },
      { e: 10, n: 0, z: 9 },
      { e: 10, n: 10, z: 9 },
    ]);
  });
});

describe('preparing surfaces', () => {
  const manifest = {
    captures: [
      { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
      { id: 'd2', label: 'Survey 6 April 2026', date: '2026-04-06' },
    ],
    layers: [
      { kind: 'raster', id: 'dsm-d1', role: 'dsm', capture: 'd1', name: 'DSM 1' },
      { kind: 'raster', id: 'ortho-d1', role: 'ortho', capture: 'd1', name: 'Ortho 1' },
      { kind: 'raster', id: 'dsm-d2', role: 'dsm', capture: 'd2', name: 'DSM 2' },
    ],
  } as unknown as Pick<ProjectManifest, 'captures' | 'layers'>;

  it('asks for every capture DSM not prepared yet', () => {
    expect(prepareParams(manifest, [])).toEqual({
      surfaces: [
        {
          id: 'dsm-d1',
          name: 'Survey 2 March 2026 DSM',
          source: { kind: 'dsm', layer: 'dsm-d1' },
          capture: 'd1',
        },
        {
          id: 'dsm-d2',
          name: 'Survey 6 April 2026 DSM',
          source: { kind: 'dsm', layer: 'dsm-d2' },
          capture: 'd2',
        },
      ],
    });
    const done = [{ source: { kind: 'dsm', layer: 'dsm-d1' } }] as unknown as HeightTiles[];
    expect(prepareParams(manifest, done)?.surfaces.map((s) => s.id)).toEqual(['dsm-d2']);
    expect(
      prepareParams(manifest, [
        ...done,
        { source: { kind: 'dsm', layer: 'dsm-d2' } } as unknown as HeightTiles,
      ]),
    ).toBeNull();
  });
});
