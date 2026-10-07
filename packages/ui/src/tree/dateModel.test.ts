import type { Capture, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { mockIssue, mockManifest } from '../__fixtures__/project';
import { EVERY_DATE, buildDateTree } from './dateModel';

const base = mockManifest();
const captures: Capture[] = [
  { id: 'a', label: 'Survey A', date: '2024-09-04' },
  { id: 'b', label: '2024-10-02', date: '2024-10-02' },
  { id: 'c', label: 'Survey C', date: '2024-11-06' },
];
const manifest: ProjectManifest = { ...base, captures };
// Extract layer IDs - mockManifest always provides at least 2 layers
const layerIds = base.layers.map((l) => l.id);
const of = { [layerIds[0]]: 'a', [layerIds[1]]: 'c' };
const labels = { every: 'Every date', dateLabel: (c: Capture) => c.date };

describe('buildDateTree', () => {
  const folders = buildDateTree(manifest, [mockIssue()], {}, { captures, of }, labels);

  it('puts Every date first, then dates newest first', () => {
    expect(folders.map((f) => f.id)).toEqual([EVERY_DATE, 'c', 'b', 'a']);
  });
  it('places each dated layer in its date folder only', () => {
    expect(folders.find((f) => f.id === 'a')?.layerIds).toEqual([layerIds[0]]);
    expect(folders.find((f) => f.id === EVERY_DATE)?.layerIds).not.toContain(layerIds[0]);
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
    const only = { ...manifest, layers: [base.layers[0]] };
    const f = buildDateTree(only, [], {}, { captures, of: { [layerIds[0]]: 'a' } }, labels);
    expect(f[0]?.id).toBe('c');
  });
});
