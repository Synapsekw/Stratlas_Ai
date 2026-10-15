import { describe, expect, it } from 'vitest';
import { ctx } from '../testing';
import { acceptMany } from './accept';
import type { Detection } from './model';
import { canUndo, initialReview, reviewReducer, type ReviewState } from './review';

const NOW = '2026-10-15T10:00:00.000Z';

function det(id: string, over: Partial<Detection> = {}): Detection {
  return {
    id,
    pass: 'model-r1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p1' },
    size: [100, 100],
    geom: { type: 'box', x: 10, y: 10, w: 20, h: 20 },
    classId: 'crack',
    severity: 3,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'model', producer: 'detector' },
    ...over,
  };
}

const loaded = (ds: Detection[]): ReviewState =>
  reviewReducer(initialReview(), { type: 'load', detections: ds });

describe('acceptMany', () => {
  it('acceptMany takes drafts only and reports why the rest are skipped', () => {
    const r = acceptMany(
      [
        det('ok'),
        det('noclass', { classId: '', label: 'spalling' }),
        det('nosev', { severity: null }),
        det('done', { status: 'accepted', issueId: 'x' }),
        det('rej', { status: 'rejected' }),
      ],
      ctx,
    );
    expect(r.accepted.map((a) => a.detection.id)).toEqual(['ok']);
    expect(r.accepted[0]?.input).toMatchObject({ classId: 'crack', severity: 3, source: 'agent' });
    expect(r.skipped.map((s) => [s.detection.id, s.problem])).toEqual([
      ['noclass', 'no-class'],
      ['nosev', 'no-severity'],
    ]);
  });
});

describe('review batches', () => {
  it('acceptedMany is one undoable step marked as issues', () => {
    const s0 = loaded([det('a'), det('b'), det('c')]);
    const s1 = reviewReducer(s0, {
      type: 'acceptedMany',
      items: [
        { id: 'a', issueId: 'i1' },
        { id: 'b', issueId: 'i2' },
      ],
      label: 'Accept 2 detections',
      by: 'DR',
      now: NOW,
    });
    expect(s1.detections.filter((d) => d.status === 'accepted').map((d) => d.issueId)).toEqual([
      'i1',
      'i2',
    ]);
    expect(s1.past.at(-1)).toMatchObject({ label: 'Accept 2 detections', issues: true });
    expect(canUndo(s1)).toBe(true);
    const s2 = reviewReducer(s1, { type: 'undo' });
    expect(s2.detections.every((d) => d.status === 'draft' && !d.issueId)).toBe(true);
    const s3 = reviewReducer(s2, { type: 'redo' });
    expect(s3.detections.filter((d) => d.status === 'accepted')).toHaveLength(2);
  });

  it('acceptedMany leaves accepted detections alone and is a no-op with nothing to do', () => {
    const s0 = loaded([det('a', { status: 'accepted', issueId: 'old' })]);
    const s1 = reviewReducer(s0, {
      type: 'acceptedMany',
      items: [{ id: 'a', issueId: 'new' }],
      label: 'Accept 1 detection',
      by: 'DR',
      now: NOW,
    });
    expect(s1).toBe(s0);
  });

  it('rejectMany rejects the drafts as one step and undo brings them back', () => {
    const s0 = loaded([det('a'), det('b'), det('c', { status: 'accepted', issueId: 'x' })]);
    const s1 = reviewReducer(s0, {
      type: 'rejectMany',
      ids: ['a', 'b', 'c'],
      label: 'Reject 2 detections',
      by: 'DR',
      now: NOW,
    });
    expect(s1.detections.map((d) => d.status)).toEqual(['rejected', 'rejected', 'accepted']);
    expect(s1.past).toHaveLength(1);
    const s2 = reviewReducer(s1, { type: 'undo' });
    expect(s2.detections.map((d) => d.status)).toEqual(['draft', 'draft', 'accepted']);
  });

  it('reclass moves waiting and rejected detections of a class, not accepted ones', () => {
    const s0 = loaded([
      det('a'),
      det('b', { status: 'rejected' }),
      det('c', { status: 'accepted', issueId: 'x' }),
      det('d', { classId: 'blister' }),
    ]);
    const s1 = reviewReducer(s0, { type: 'reclass', from: 'crack', to: 'pothole', now: NOW });
    expect(s1.detections.map((d) => d.classId)).toEqual(['pothole', 'pothole', 'crack', 'blister']);
    expect(reviewReducer(s0, { type: 'reclass', from: 'nope', to: 'pothole', now: NOW })).toBe(s0);
  });
});
