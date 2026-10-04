import { describe, expect, it } from 'vitest';
import { groupLayers, toggleGroup, validatePassphrase } from './packageModel';

const layers = [
  { id: 'tank', name: 'Tank', kind: 'mesh', bytes: 2_000, files: 1 },
  { id: 'c1', name: 'Cloud 1', kind: 'pointcloud', bytes: 3_000, files: 1 },
  { id: 'c2', name: 'Cloud 2', kind: 'pointcloud', bytes: 4_000, files: 2 },
  { id: 'legacy', name: 'Original review', kind: 'legacy', bytes: 9_000, files: 40 },
];

describe('package export model', () => {
  it('groups layers by kind in a stable order with their bytes', () => {
    const g = groupLayers(layers, new Set(['c2']));
    expect(g.map((x) => x.kind)).toEqual(['mesh', 'pointcloud', 'legacy']);
    const clouds = g[1];
    expect(clouds).toMatchObject({ label: 'Point clouds', bytes: 7_000, count: 2 });
    expect(clouds?.state).toBe('some');
    expect(g[0]?.state).toBe('all');
  });

  it('turns a whole group off and on', () => {
    const off = toggleGroup(new Set<string>(), layers, 'pointcloud');
    expect([...off].sort()).toEqual(['c1', 'c2']);
    const on = toggleGroup(off, layers, 'pointcloud');
    expect([...on]).toEqual([]);
  });

  it('asks for a passphrase of 8 characters typed the same twice', () => {
    expect(validatePassphrase('short', 'short')).toMatch(/8/);
    expect(validatePassphrase('long enough', 'long enougH')).toMatch(/match/);
    expect(validatePassphrase('long enough', 'long enough')).toBeNull();
  });
});
