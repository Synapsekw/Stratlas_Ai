import type { Capture, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { mockIssue, mockManifest } from '../__fixtures__/project';
import { ICONS } from '../icons/paths';
import {
  DATE_ICONS,
  EVERY_DATE,
  buildDateTree,
  captureLabelFor,
  captureName,
  dateIcon,
  dropCapture,
} from './dateModel';
import { datableLayerIds } from './model';

const base = mockManifest();
const captures: Capture[] = [
  { id: 'a', label: 'Survey A', date: '2024-09-04' },
  { id: 'b', label: '2024-10-02', date: '2024-10-02' },
  { id: 'c', label: 'Survey C', date: '2024-11-06' },
];
// mockManifest always provides at least 2 layers (plant and lidar)
// Use optional chaining to satisfy TypeScript while the test fixture guarantees they exist
const firstLayerId = base.layers[0]?.id ?? 'plant';
const secondLayerId = base.layers[1]?.id ?? 'lidar';
const manifest: ProjectManifest = { ...base, captures };
const of = { [firstLayerId]: 'a', [secondLayerId]: 'c' };
const labels = { every: 'Every date', dateLabel: (c: Capture) => c.date };

describe('buildDateTree', () => {
  const folders = buildDateTree(manifest, [mockIssue()], {}, { captures, of }, labels);

  it('puts Every date first, then dates newest first', () => {
    expect(folders.map((f) => f.id)).toEqual([EVERY_DATE, 'c', 'b', 'a']);
  });
  it('places each dated layer in its date folder only', () => {
    expect(folders.find((f) => f.id === 'a')?.layerIds).toEqual([firstLayerId]);
    expect(folders.find((f) => f.id === EVERY_DATE)?.layerIds).not.toContain(firstLayerId);
  });
  it('keeps an empty date folder with no groups', () => {
    const b = folders.find((f) => f.id === 'b');
    expect(b?.groups).toEqual([]);
    expect(b?.layerIds).toEqual([]);
  });
  it('shows the capture label as sub text when it differs from the date', () => {
    expect(folders.find((f) => f.id === 'a')?.sub).toBe('Survey A');
    expect(folders.find((f) => f.id === 'b')?.sub).toBeUndefined();
  });
  it('keeps annotations in Every date', () => {
    const every = folders.find((f) => f.id === EVERY_DATE);
    expect(every?.groups.some((g) => g.kind === 'annotations')).toBe(true);
    expect(folders.find((f) => f.id === 'a')?.groups.some((g) => g.kind === 'annotations')).toBe(
      false,
    );
  });
  it('drops Every date when it would be empty', () => {
    const only = { ...manifest, layers: base.layers.slice(0, 1) };
    const f = buildDateTree(only, [], {}, { captures, of: { [firstLayerId]: 'a' } }, labels);
    expect(f[0]?.id).toBe('c');
  });
  it('moves a layer to the folder of the date it was filed under, and nowhere else', () => {
    const moved = buildDateTree(
      manifest,
      [],
      {},
      { captures, of: { [firstLayerId]: 'b', [secondLayerId]: 'c' } },
      labels,
    );
    expect(moved.find((f) => f.id === 'b')?.layerIds).toEqual([firstLayerId]);
    expect(moved.find((f) => f.id === 'a')?.layerIds).toEqual([]);
    const all = moved.flatMap((f) => f.layerIds);
    expect(all.filter((id) => id === firstLayerId)).toHaveLength(1);
    // every layer of the manifest is still in exactly one folder
    expect([...all].sort()).toEqual(base.layers.map((l) => l.id).sort());
  });
});

describe('date folder names, icons and drops', () => {
  const c: Capture = { id: 'a', label: 'Baseline', date: '2024-09-04' };

  it('a capture is named unless its label only repeats the date', () => {
    expect(captureName(c, '4 Sep 2024')).toBe('Baseline');
    expect(captureName({ ...c, label: '2024-09-04' }, '4 Sep 2024')).toBeUndefined();
    expect(captureName({ ...c, label: '4 Sep 2024' }, '4 Sep 2024')).toBeUndefined();
  });

  it('saves the typed name, or the plain date for an emptied field', () => {
    expect(captureLabelFor(c, '  After the blast ')).toBe('After the blast');
    expect(captureLabelFor(c, '   ')).toBe('2024-09-04');
    // and a label that is the plain date shows no name
    expect(captureName({ ...c, label: captureLabelFor(c, '') }, '4 Sep 2024')).toBeUndefined();
  });

  it('offers only icons the set can draw, and knows a saved one', () => {
    for (const name of DATE_ICONS) expect(Object.hasOwn(ICONS, name), name).toBe(true);
    expect(new Set(DATE_ICONS).size).toBe(DATE_ICONS.length);
    expect(dateIcon('flag')).toBe('flag');
    expect(dateIcon('from-a-newer-build')).toBeUndefined();
    expect(dateIcon('toString')).toBeUndefined();
    expect(dateIcon(undefined)).toBeUndefined();
  });

  it('a drop on a date folder files under its capture, on Every date under none', () => {
    expect(dropCapture({ capture: c })).toBe('a');
    expect(dropCapture({ capture: null })).toBeNull();
  });

  it('rows carry the layers that can be dated: not a basemap, a review or the issues', () => {
    expect(datableLayerIds({ id: 'm', layerId: 'm', layerKind: 'mesh', name: 'Model' })).toEqual([
      'm',
    ]);
    expect(
      datableLayerIds({ id: 'b', layerId: 'b', layerKind: 'basemap', name: 'Offline map' }),
    ).toEqual([]);
    expect(datableLayerIds({ id: 'l', layerId: 'l', layerKind: 'legacy', name: 'Review' })).toEqual(
      [],
    );
    expect(datableLayerIds({ id: 'issues', name: 'Issues' })).toEqual([]);
    // a flight row carries its clips
    expect(
      datableLayerIds({
        id: 'flight:f1',
        flightId: 'f1',
        name: 'Flight 1',
        children: [
          { id: 'c1', layerId: 'c1', layerKind: 'video', name: 'clip 1' },
          { id: 'c2', layerId: 'c2', layerKind: 'video', name: 'clip 2' },
        ],
      }),
    ).toEqual(['c1', 'c2']);
  });
});
