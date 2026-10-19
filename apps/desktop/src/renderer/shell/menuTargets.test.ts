import { describe, expect, it } from 'vitest';
import { makeActionCtx } from '@aio/ui';
import type { ProjectManifest } from '@aio/schema';
import { measureTarget, menuTitle, rowTarget } from './menuTargets';

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

describe('measureTarget', () => {
  it('a measurement menu takes the marked measurements and ignores marked layers', () => {
    const marked = new Set(['measure:a', 'measure:b', 'layer1']);
    expect(measureTarget('a', marked)).toEqual({
      kind: 'measurements',
      ids: ['a', 'b'],
      clicked: 'a',
    });
    expect(measureTarget('c', marked)).toEqual({ kind: 'measurements', ids: ['c'], clicked: 'c' });
    expect(rowTarget({ id: 'layer1', layerId: 'layer1', name: 'L' }, marked)).toEqual({
      kind: 'layers',
      layerIds: ['layer1'],
    });
  });
  it('one marked measurement is just that one; marked layers keep the measurements out', () => {
    expect(measureTarget('a', new Set(['measure:a', 'layer1']))).toEqual({
      kind: 'measurements',
      ids: ['a'],
      clicked: 'a',
    });
    expect(
      rowTarget({ id: 'l1', layerId: 'l1', name: 'L' }, new Set(['l1', 'l2', 'measure:a'])),
    ).toEqual({ kind: 'layers', layerIds: ['l1', 'l2'] });
  });
  it('counts several measurements in the heading, names one', () => {
    const ctx = makeActionCtx({ manifest: { layers: [] } as unknown as ProjectManifest });
    expect(menuTitle({ kind: 'measurements', ids: ['a', 'b'], clicked: 'a' }, ctx, 'A')).toBe(
      '2 measurements',
    );
    expect(menuTitle({ kind: 'measurements', ids: ['a'], clicked: 'a' }, ctx, 'A')).toBe('A');
  });
});
