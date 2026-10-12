import { describe, expect, it } from 'vitest';
import { groupLayers, toggleGroup, validatePassphrase } from './packageModel';

const layers = [
  { id: 'tank', name: 'Tank', kind: 'mesh', bytes: 2_000, files: 1 },
  { id: 'c1', name: 'Cloud 1', kind: 'pointcloud', bytes: 3_000, files: 1 },
  { id: 'c2', name: 'Cloud 2', kind: 'pointcloud', bytes: 4_000, files: 2 },
];

describe('package export model', () => {
  it('groups layers by kind in a stable order with their bytes', () => {
    const g = groupLayers(layers, new Set(['c2']));
    expect(g.map((x) => x.kind)).toEqual(['mesh', 'pointcloud']);
    const clouds = g[1];
    expect(clouds).toMatchObject({ label: 'Point clouds', bytes: 7_000, count: 2 });
    expect(clouds?.state).toBe('some');
    expect(g[0]?.state).toBe('all');
  });

  it('offers no group for a retired viewer and counts it nowhere', () => {
    const viewer = { id: 'legacy', name: 'Old viewer', kind: 'legacy', bytes: 5_000, files: 40 };
    const g = groupLayers([...layers, viewer], new Set<string>());
    expect(g.map((x) => x.kind)).toEqual(['mesh', 'pointcloud']);
    expect(g.reduce((n, x) => n + x.count, 0)).toBe(3);
    expect(g.reduce((n, x) => n + x.bytes, 0)).toBe(9_000);
    expect(g.flatMap((x) => x.layers).some((l) => l.id === 'legacy')).toBe(false);
  });

  it('groups walks under 360 walks', () => {
    const walk = { id: 'walk-a', name: 'Walk', kind: 'walk', bytes: 9_000, files: 6 };
    const g = groupLayers([...layers, walk], new Set<string>());
    expect(g.find((x) => x.kind === 'walk')).toMatchObject({ label: '360 walks', count: 1 });
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
