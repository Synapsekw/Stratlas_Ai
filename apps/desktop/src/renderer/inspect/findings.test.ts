import type { Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { findingsIndex } from '../screens/mediaFindings';
import {
  chipCounts,
  findingsOnPhoto,
  followSelection,
  nextPhotoToReview,
  panelLayout,
  photoPosition,
  visibleDetections,
} from './findings';

const manifest = {
  severityModels: [
    {
      id: 'sev',
      name: 'Kit',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 3, label: 'Severe', color: '#ee3f4b', criteria: '' },
      ],
    },
  ],
  classCatalogues: [],
};
const SETS = [{ id: 'photos', items: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }];
const P1 = { layerId: 'photos', photoId: 'p1' };
const P2 = { layerId: 'photos', photoId: 'p2' };
const P3 = { layerId: 'photos', photoId: 'p3' };
const ORDER = [P1, P2, P3];
const box = { type: 'box', x: 1, y: 2, w: 3, h: 4 } as const;

function issue(id: string, severity: Issue['severity'], photos: string[]): Issue {
  return {
    id,
    code: id.toUpperCase(),
    classId: 'crack',
    severityModelId: 'sev',
    severity,
    status: 'reviewed',
    title: id,
    note: '',
    author: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sightings: photos.map((photo) => ({ on: 'image', layer: 'photos', photo, geom: box })),
    source: 'import',
  };
}
const ISSUES = [
  issue('i-minor', 1, ['p1']),
  issue('i-severe', 3, ['p1']),
  issue('i-on-p1-and-p2', 1, ['p1', 'p2']),
];

function det(id: string, photo: string, patch: Partial<Detection>): Detection {
  return {
    id,
    pass: 'ai-1.json',
    source: { kind: 'photo', layer: 'photos', photo },
    size: [100, 100],
    geom: box,
    classId: 'crack',
    severity: null,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'ai' },
    ...patch,
  } as Detection;
}
const DETS = [
  det('d-high', 'p1', { confidence: 0.9 }),
  det('d-low', 'p2', { confidence: 0.2 }),
  det('d-accepted', 'p1', { status: 'accepted', issueId: 'i-minor' }),
  det('d-rejected', 'p3', { status: 'rejected' }),
];
const visible = visibleDetections({ detections: DETS, minConfidence: 0.5, passThreshold: {} });

describe('findings model', () => {
  it('hides drafts under the confidence bar and keeps decided ones', () => {
    expect(visible.map((d) => d.id)).toEqual(['d-high', 'd-accepted', 'd-rejected']);
  });

  it('lists the issues then the waiting drafts of one photo', () => {
    const rows = findingsOnPhoto({
      pick: P1,
      issues: ISSUES,
      detections: visible,
      selectedIssueId: null,
      currentDetectionId: 'd-high',
    });
    expect(rows.map((r) => [r.kind, r.key])).toEqual([
      ['you', 'issue:i-severe'],
      ['you', 'issue:i-minor'],
      ['you', 'issue:i-on-p1-and-p2'],
      ['ai', 'det:d-high'],
    ]);
    expect(rows[3]).toMatchObject({ confidence: 0.9, selected: true });
  });

  it('does not count drafts under the bar in To review', () => {
    const index = findingsIndex(manifest, ISSUES, visible);
    expect(chipCounts(SETS, index)).toEqual({ review: 1, findings: 2, all: 3 });
  });

  it('finds the next photo to review and wraps round', () => {
    const index = findingsIndex(manifest, ISSUES, visible);
    expect(nextPhotoToReview(ORDER, index, P3)).toEqual(P1);
    expect(nextPhotoToReview(ORDER, new Map(), P1)).toBeNull();
    expect(nextPhotoToReview(ORDER, index, null)).toEqual(P1);
  });

  it('says where a photo sits in the order', () => {
    expect(photoPosition(ORDER, P2)).toEqual({ index: 1, total: 3 });
    expect(photoPosition(ORDER, null)).toBeNull();
  });

  it('keeps the open photo when an issue on it is selected', () => {
    expect(followSelection(P2, { kind: 'issue', id: 'i-on-p1-and-p2' }, ISSUES)).toEqual(P2);
    expect(followSelection(P3, { kind: 'issue', id: 'i-on-p1-and-p2' }, ISSUES)).toEqual(P1);
    expect(followSelection(P3, { kind: 'photo', id: 'p2', layer: 'photos' }, ISSUES)).toEqual(P2);
    expect(followSelection(P3, { kind: 'photo', id: 'p2' }, ISSUES, SETS)).toEqual(P2);
    expect(followSelection(P3, { kind: 'clip', id: 'c' }, ISSUES)).toEqual(P3);
  });

  it('turns the panel into a drawer below 1000 px', () => {
    expect(panelLayout(1044)).toBe('columns');
    expect(panelLayout(999)).toBe('drawer');
  });
});
