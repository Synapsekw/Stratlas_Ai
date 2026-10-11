import type { Issue } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findingsIndex, photoKey } from './mediaFindings';
import {
  DEFAULT_MEDIA_VIEW,
  highestLevel,
  mediaView,
  noPhotoMatches,
  photosInView,
  setMediaView,
} from './mediaView';

const manifest = {
  severityModels: [
    {
      id: 'sev',
      name: 'Kit',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
        { value: 3, label: 'Severe', color: '#ee3f4b', criteria: '' },
      ],
      uncertain: { label: 'Uncertain', color: '#b68ef8' },
    },
  ],
  classCatalogues: [],
};

const box = { type: 'box', x: 10, y: 20, w: 30, h: 40 } as const;

function issue(id: string, severity: Issue['severity'], photo: string): Issue {
  return {
    id,
    code: `D${id.padStart(2, '0')}`,
    classId: 'crack',
    severityModelId: 'sev',
    severity,
    status: 'reviewed',
    title: id,
    note: '',
    author: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sightings: [{ on: 'image', layer: 'photos', photo, geom: box }],
    source: 'import',
  };
}

const items = [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
// p1 level 1; p2 levels 2 and 3; p3 level 3; p4 level 2; p0 nothing
const index = findingsIndex(manifest, [
  issue('1', 1, 'p1'),
  issue('2', 2, 'p2'),
  issue('3', 3, 'p2'),
  issue('4', 3, 'p3'),
  issue('5', 2, 'p4'),
]);
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const view = (patch: Partial<typeof DEFAULT_MEDIA_VIEW>) => ({ ...DEFAULT_MEDIA_VIEW, ...patch });

beforeEach(() => {
  workspace.setState({ project: null });
  mediaView.setState(DEFAULT_MEDIA_VIEW);
});
afterEach(() => {
  workspace.setState({ project: null });
});

describe('the photos of a set in view', () => {
  it('shows everything in set order by default', () => {
    expect(ids(photosInView(items, 'photos', index, DEFAULT_MEDIA_VIEW))).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });

  it('keeps only the photos with a finding of the chosen level, and drops the rest', () => {
    expect(ids(photosInView(items, 'photos', index, view({ severity: 3 })))).toEqual(['p2', 'p3']);
    expect(ids(photosInView(items, 'photos', index, view({ severity: 1 })))).toEqual(['p1']);
    expect(ids(photosInView(items, 'photos', index, view({ severity: 'uncertain' })))).toEqual([]);
  });

  it('keeps only the photos in the scope, in the order of the set', () => {
    const scope = { label: 'Facade', ids: [photoKey('photos', 'p3'), photoKey('photos', 'p1')] };
    expect(ids(photosInView(items, 'photos', index, view({ scope })))).toEqual(['p1', 'p3']);
    // a photo set other than the scope's layer has none of its keys
    expect(photosInView(items, 'thermal', index, view({ scope }))).toEqual([]);
  });

  it('puts the worst photos first when ordered by severity', () => {
    expect(ids(photosInView(items, 'photos', index, view({ order: 'severity' })))).toEqual([
      'p2',
      'p3',
      'p4',
      'p1',
      'p0',
    ]);
  });

  it('applies the scope, then the level, then the order', () => {
    const scope = { label: 'Some', ids: ['photos/p1', 'photos/p2', 'photos/p4'] };
    expect(
      ids(photosInView(items, 'photos', index, view({ scope, severity: 2, order: 'severity' }))),
    ).toEqual(['p2', 'p4']);
  });

  it('with only-with-findings leaves the photos without one out', () => {
    expect(ids(photosInView(items, 'photos', index, view({ onlyFindings: true })))).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
  });
});

describe('the highest level present', () => {
  const three = findingsIndex(manifest, [
    issue('1', 1, 'a'),
    issue('2', 2, 'b'),
    issue('3', 3, 'c'),
  ]);

  it('is the worst level over all photos, or over a scope', () => {
    expect(highestLevel(three, null)).toBe(3);
    expect(highestLevel(three, ['photos/a', 'photos/b'])).toBe(2);
  });

  it('is uncertain when that is all there is, and null when nothing is graded', () => {
    const unsure = findingsIndex(manifest, [issue('1', 'uncertain', 'a')]);
    expect(highestLevel(unsure, null)).toBe('uncertain');
    expect(highestLevel(new Map(), null)).toBeNull();
    expect(highestLevel(three, ['photos/none'])).toBeNull();
  });

  it('is null for ungraded detections only', () => {
    const ungraded = findingsIndex(
      manifest,
      [],
      [
        {
          id: 'd',
          pass: 'review.json',
          source: { kind: 'photo', layer: 'photos', photo: 'a' },
          size: [1, 1],
          geom: { type: 'box', x: 0.25, y: 0.5, w: 0.25, h: 0.25 },
          classId: 'crack',
          severity: null,
          uncertain: false,
          note: '',
          status: 'draft',
          origin: { kind: 'human', author: 'x' },
        },
      ],
    );
    expect(highestLevel(ungraded, null)).toBeNull();
  });
});

describe('the view store', () => {
  it('starts unfiltered, in file order', () => {
    expect(DEFAULT_MEDIA_VIEW).toEqual({
      onlyFindings: false,
      order: 'file',
      severity: null,
      scope: null,
    });
  });

  it('merges a patch', () => {
    setMediaView({ order: 'severity', severity: 2 });
    expect(mediaView.getState()).toMatchObject({
      order: 'severity',
      severity: 2,
      onlyFindings: false,
    });
  });

  it('clears the scope and the level, and keeps the order, when another project opens', () => {
    workspace.setState({ project: { id: 'a' } } as unknown as Parameters<
      typeof workspace.setState
    >[0]);
    setMediaView({
      order: 'severity',
      onlyFindings: true,
      severity: 3,
      scope: { label: 'Some', ids: ['photos/p1'] },
    });
    workspace.setState({ project: { id: 'b' } } as unknown as Parameters<
      typeof workspace.setState
    >[0]);
    expect(mediaView.getState()).toMatchObject({
      scope: null,
      severity: null,
      order: 'severity',
      onlyFindings: true,
    });
  });

  it('keeps the scope and the level while the same project reloads', () => {
    workspace.setState({ project: { id: 'a' } } as unknown as Parameters<
      typeof workspace.setState
    >[0]);
    setMediaView({ severity: 2, scope: { label: 'Some', ids: ['photos/p1'] } });
    workspace.setState({ project: { id: 'a', root: 'x' } } as unknown as Parameters<
      typeof workspace.setState
    >[0]);
    expect(mediaView.getState().scope).not.toBeNull();
    expect(mediaView.getState().severity).toBe(2);
  });
});

describe('a filter that matches nothing', () => {
  const sets = [{ id: 'photos', items }];

  it('is reported only when a level or a scope is set and no photo passes', () => {
    expect(noPhotoMatches(sets, index, view({ severity: 'uncertain' }))).toBe(true);
    expect(noPhotoMatches(sets, index, view({ scope: { label: 'x', ids: ['photos/zz'] } }))).toBe(
      true,
    );
    expect(noPhotoMatches(sets, index, view({ severity: 3 }))).toBe(false);
  });

  it('is not reported without a level or a scope, nor when another set still matches', () => {
    expect(noPhotoMatches([], index, DEFAULT_MEDIA_VIEW)).toBe(false);
    expect(noPhotoMatches(sets, new Map(), view({ onlyFindings: true }))).toBe(false);
    expect(noPhotoMatches([{ id: 'thermal', items }, ...sets], index, view({ severity: 3 }))).toBe(
      false,
    );
  });
});
