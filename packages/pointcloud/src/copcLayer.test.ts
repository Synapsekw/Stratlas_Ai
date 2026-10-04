import { describe, expect, it } from 'vitest';
import type { CopcSource } from './copc';
import { copcChunkSeeds } from './copcLayer';

const source: CopcSource = {
  layout: {
    pointDataRecordFormat: 7,
    pointDataRecordLength: 36,
    scale: [0.001, 0.001, 0.001],
    offset: [0, 0, 0],
  },
  cube: { min: [1000, 2000, 0], max: [1064, 2064, 64] },
  spacing: 0.5,
  pointCount: 600,
  rootPage: { pageOffset: 0, pageLength: 0 },
};
const origin = [1000, 2064, 0] as const;
const node = (n: number) => ({ pointCount: n, pointDataOffset: 0, pointDataLength: 10 });

describe('copcChunkSeeds', () => {
  const hier = {
    nodes: { '0-0-0-0': node(300), '1-0-0-0': node(200), '1-1-0-0': node(100) },
    pages: { '1-1-1-1': { pageOffset: 99, pageLength: 32 } },
  };
  const seeds = copcChunkSeeds('cloud', 'aio://c', source, hier, origin);
  const byKey = new Map(seeds.map((s) => [s.key, s]));

  it('makes one chunk per node, keyed by layer, with the root at lod 0', () => {
    expect(seeds.map((s) => s.key).sort()).toEqual([
      'cloud#0-0-0-0',
      'cloud#1-0-0-0',
      'cloud#1-1-0-0',
      'cloud#1-1-1-1',
    ]);
    expect(byKey.get('cloud#0-0-0-0')?.lod).toBe(0);
    expect(byKey.get('cloud#1-0-0-0')?.lod).toBe(1);
  });

  it('lists children that exist in the page, including page placeholders', () => {
    expect([...(byKey.get('cloud#0-0-0-0')?.children ?? [])].sort()).toEqual([
      'cloud#1-0-0-0',
      'cloud#1-1-0-0',
      'cloud#1-1-1-1',
    ]);
    expect(byKey.get('cloud#1-0-0-0')?.children).toEqual([]);
  });

  it('halves the spacing per level and places node boxes in the local frame', () => {
    expect(byKey.get('cloud#0-0-0-0')?.spacing).toBe(0.5);
    expect(byKey.get('cloud#1-0-0-0')?.spacing).toBe(0.25);
    expect(byKey.get('cloud#1-1-0-0')?.bounds).toEqual({ min: [32, 0, 32], max: [64, 32, 64] });
  });

  it('marks nodes in unloaded pages as placeholders with no points', () => {
    const p = byKey.get('cloud#1-1-1-1');
    expect(p?.page).toEqual({ pageOffset: 99, pageLength: 32 });
    expect(p?.points).toBe(0);
    const n = byKey.get('cloud#1-0-0-0');
    expect(n?.source).toMatchObject({ kind: 'copc', url: 'aio://c', node: node(200) });
    expect(n?.page).toBeUndefined();
  });
});
