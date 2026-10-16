import { describe, expect, it } from 'vitest';
import { rowTarget } from './menuTargets';

describe('rowTarget', () => {
  const row = { id: 'a', layerId: 'a', layerKind: 'mesh' as const, name: 'A' };
  it('a marked row targets every marked row', () => {
    expect(rowTarget(row, new Set(['a', 'b', 'c']))).toEqual({
      kind: 'layers',
      layerIds: ['a', 'b', 'c'],
    });
  });
  it('an unmarked row alone, marks untouched', () => {
    const marked = new Set(['b', 'c']);
    expect(rowTarget(row, marked)).toEqual({ kind: 'layers', layerIds: ['a'] });
    expect([...marked]).toEqual(['b', 'c']);
  });
  it('one marked row is just that row; a flight row carries its clips; Issues is annotations', () => {
    expect(rowTarget(row, new Set(['a']))).toEqual({ kind: 'layers', layerIds: ['a'] });
    expect(
      rowTarget(
        {
          id: 'flight:f',
          name: 'F',
          children: [
            { id: 'c1', layerId: 'c1', name: 'c1' },
            { id: 'c2', layerId: 'c2', name: 'c2' },
          ],
        },
        new Set(),
      ),
    ).toEqual({ kind: 'layers', layerIds: ['c1', 'c2'] });
    expect(rowTarget({ id: 'issues', name: 'Issues' }, new Set())).toEqual({
      kind: 'annotations',
      row: 'issues',
    });
    expect(rowTarget({ id: 'drafts', name: 'Drafts' }, new Set())).toEqual({
      kind: 'annotations',
      row: 'drafts',
    });
  });
  it('a basemap row targets its layer; a row with nothing behind it targets nothing', () => {
    expect(
      rowTarget({ id: 'bm', layerId: 'bm', layerKind: 'basemap', name: 'Map' }, new Set()),
    ).toEqual({
      kind: 'layers',
      layerIds: ['bm'],
    });
    expect(rowTarget({ id: 'x', name: 'X' }, new Set())).toBeNull();
  });
});
