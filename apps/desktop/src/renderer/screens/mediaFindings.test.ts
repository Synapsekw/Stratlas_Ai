import type { Detection } from '@aio/annotate/detections';
import type { Issue, ProjectManifest } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { findingsIndex, orderPhotos, photoKey, shapesInPhoto } from './mediaFindings';

const manifest: Pick<ProjectManifest, 'severityModels' | 'classCatalogues'> = {
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
  classCatalogues: [
    {
      id: 'c',
      name: 'Classes',
      assetType: 'facade',
      classes: [
        { id: 'crack', label: 'Crack', color: '#123456', severityModel: 'sev' },
        { id: 'stain', label: 'Stain', color: '#654321', severityModel: 'sev' },
      ],
    },
  ],
};

function issue(id: string, severity: Issue['severity'], sightings: Issue['sightings']): Issue {
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
    sightings,
    source: 'import',
  };
}

function det(over: Partial<Detection>): Detection {
  return {
    id: 'd',
    pass: 'review.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p3' },
    size: [1, 1],
    geom: { type: 'box', x: 0.25, y: 0.5, w: 0.25, h: 0.25 },
    classId: 'stain',
    severity: 1,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'human', author: 'x' },
    ...over,
  };
}

const box = { type: 'box', x: 10, y: 20, w: 30, h: 40 } as const;

describe('findings per photo', () => {
  const issues = [
    issue('1', 1, [
      { on: 'image', layer: 'photos', photo: 'p1', geom: box },
      {
        on: 'image',
        layer: 'photos',
        photo: 'p1',
        geom: { type: 'mask', src: { path: 'photos/masks/p1_mask.png' } },
      },
      { on: 'mesh', layer: 'm', geom: { type: 'spoint', p: [0, 0, 0], n: [0, 1, 0] } },
    ]),
    issue('2', 3, [{ on: 'image', layer: 'photos', photo: 'p1', geom: box }]),
    issue('3', 'uncertain', [
      { on: 'image', layer: 'photos', photo: 'p2', geom: { type: 'point', x: 5, y: 5 } },
    ]),
  ];
  const detections = [
    det({ id: 'a' }),
    det({ id: 'b', status: 'rejected' }),
    // already issue 2 on p1: not counted twice
    det({
      id: 'c',
      status: 'accepted',
      issueId: '2',
      source: { kind: 'photo', layer: 'photos', photo: 'p1' },
    }),
    det({ id: 'd', source: { kind: 'frame', layer: 'clip', t: 2 } }),
    det({ id: 'e', severity: null, classId: 'crack', status: 'accepted' }),
  ];
  const index = findingsIndex(manifest, issues, detections);

  it('counts issues once per photo and takes the worst severity', () => {
    const p1 = index.get(photoKey('photos', 'p1'));
    expect(p1).toMatchObject({
      issues: 2,
      detections: 0,
      count: 2,
      rank: 3,
      color: '#ee3f4b',
      label: 'Severe',
      issueIds: ['2', '1'],
    });
    // the mask is not drawn on a thumbnail; both boxes are
    expect(p1?.shapes).toHaveLength(2);
  });

  it('ranks uncertain below graded levels with its own colour', () => {
    expect(index.get('photos/p2')).toMatchObject({ rank: 0.5, color: '#b68ef8', count: 1 });
  });

  it('adds detections that are not rejected, in their own pixel grid', () => {
    const p3 = index.get('photos/p3');
    expect(p3).toMatchObject({ issues: 0, detections: 2, drafts: 1, count: 2 });
    expect(p3?.color).toBe('#fad34b');
    // an ungraded detection takes its class colour
    expect(p3?.shapes.map((s) => s.color)).toEqual(['#fad34b', '#123456']);
    expect(p3?.shapes[0]?.grid).toEqual([1, 1]);
  });

  it('leaves photos without findings and video frames out', () => {
    expect(index.size).toBe(3);
  });

  it('scales detection shapes to the photo', () => {
    const p3 = index.get('photos/p3');
    const [s] = shapesInPhoto(p3?.shapes ?? [], [400, 300]);
    expect(s?.geom).toEqual({ type: 'box', x: 100, y: 150, w: 100, h: 75 });
    expect(s?.grid).toBeNull();
    const [kept] = shapesInPhoto(index.get('photos/p1')?.shapes ?? [], [400, 300]);
    expect(kept?.geom).toEqual(box);
  });
});

describe('photo order', () => {
  const items = [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }, { id: 'p3' }];
  const index = findingsIndex(
    manifest,
    [
      issue('1', 1, [
        { on: 'image', layer: 'photos', photo: 'p1', geom: box },
        { on: 'image', layer: 'photos', photo: 'p3', geom: box },
      ]),
      issue('2', 1, [{ on: 'image', layer: 'photos', photo: 'p1', geom: box }]),
      issue('3', 3, [{ on: 'image', layer: 'photos', photo: 'p3', geom: box }]),
      issue('4', 2, [{ on: 'image', layer: 'photos', photo: 'p2', geom: box }]),
    ],
    [],
  );
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it('keeps the capture order, or only the photos with findings', () => {
    expect(ids(orderPhotos(items, 'photos', index, false, 'file'))).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
    ]);
    expect(ids(orderPhotos(items, 'photos', index, true, 'file'))).toEqual(['p1', 'p2', 'p3']);
  });

  it('puts the worst or the busiest photos first, ties in capture order', () => {
    expect(ids(orderPhotos(items, 'photos', index, false, 'severity'))).toEqual([
      'p3',
      'p2',
      'p1',
      'p0',
    ]);
    expect(ids(orderPhotos(items, 'photos', index, false, 'count'))).toEqual([
      'p3',
      'p1',
      'p2',
      'p0',
    ]);
  });

  it('reads findings of the right photo set only', () => {
    expect(orderPhotos(items, 'thermal', index, true, 'file')).toEqual([]);
  });
});
