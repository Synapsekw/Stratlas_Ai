import { describe, expect, it } from 'vitest';
import type { Detection } from './model';
import {
  canRedo,
  canUndo,
  currentOf,
  initialReview,
  queueOf,
  reviewReducer,
  sourceCounts,
  type ReviewAction,
  type ReviewState,
} from './review';

const NOW = '2026-10-05T10:00:00.000Z';

function det(id: string, over: Partial<Detection> = {}): Detection {
  return {
    id,
    pass: 'ai-r1.json',
    source: { kind: 'photo', layer: 'photos', photo: 'p001' },
    size: [1000, 800],
    geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
    classId: 'moderate',
    severity: 2,
    uncertain: false,
    note: '',
    status: 'draft',
    origin: { kind: 'ai', provider: 'anthropic', model: 'm', promptVersion: 'v1', runId: 'r1' },
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const run = (s: ReviewState, ...actions: ReviewAction[]) => actions.reduce(reviewReducer, s);

function loaded(list: Detection[]): ReviewState {
  return reviewReducer(initialReview(), { type: 'load', detections: list });
}

describe('review queue', () => {
  const list = [
    det('c', { source: { kind: 'photo', layer: 'photos', photo: 'p010' } }),
    det('a', {
      source: { kind: 'photo', layer: 'photos', photo: 'p002' },
      geom: { type: 'box', x: 0, y: 300, w: 9, h: 9 },
    }),
    det('b', {
      source: { kind: 'photo', layer: 'photos', photo: 'p002' },
      geom: { type: 'box', x: 0, y: 100, w: 9, h: 9 },
    }),
    det('f', { source: { kind: 'frame', layer: 'clip', t: 4 } }),
    det('e', { source: { kind: 'frame', layer: 'clip', t: 2 } }),
  ];

  it('orders by photo name (natural), then top to bottom, then frames by time', () => {
    const s = loaded(list);
    expect(queueOf(s).map((d) => d.id)).toEqual(['b', 'a', 'c', 'e', 'f']);
    expect(s.currentId).toBe('b');
  });

  it('steps with next and prev and wraps', () => {
    const s = loaded(list);
    expect(run(s, { type: 'next' }).currentId).toBe('a');
    expect(run(s, { type: 'prev' }).currentId).toBe('f');
    expect(
      run(
        s,
        { type: 'next' },
        { type: 'next' },
        { type: 'next' },
        { type: 'next' },
        { type: 'next' },
      ).currentId,
    ).toBe('b');
  });

  it('jumps to the first detection of the next and previous photo or frame', () => {
    const s = loaded(list);
    expect(run(s, { type: 'nextSource' }).currentId).toBe('c');
    expect(run(s, { type: 'nextSource' }, { type: 'nextSource' }).currentId).toBe('e');
    expect(run(s, { type: 'prevSource' }).currentId).toBe('f');
  });

  it('hides proposals under the confidence floor but never a person’s drawing', () => {
    const s = loaded([
      det('low', { confidence: 0.2 }),
      det('hi', { confidence: 0.8 }),
      det('mine', { origin: { kind: 'human', author: 'D' }, confidence: 0.1 }),
    ]);
    const f = run(s, { type: 'minConfidence', value: 0.5 });
    expect(
      queueOf(f)
        .map((d) => d.id)
        .sort(),
    ).toEqual(['hi', 'mine']);
  });

  it('counts per source', () => {
    const s = run(loaded(list), { type: 'reject', id: 'b', by: 'D', now: NOW });
    const c = sourceCounts(s.detections);
    expect(c[0]).toMatchObject({ key: 'photo:photos:p002', draft: 1, rejected: 1, accepted: 0 });
    expect(c.map((x) => x.key)).toEqual([
      'photo:photos:p002',
      'photo:photos:p010',
      'frame:clip:2000',
      'frame:clip:4000',
    ]);
  });
});

describe('review decisions', () => {
  it('reject moves on to the next draft and can be undone', () => {
    const s = loaded([det('a'), det('b', { geom: { type: 'box', x: 0, y: 500, w: 5, h: 5 } })]);
    const r = run(s, { type: 'reject', id: 'a', by: 'D', now: NOW });
    expect(r.detections.find((d) => d.id === 'a')).toMatchObject({
      status: 'rejected',
      reviewedBy: 'D',
    });
    expect(r.currentId).toBe('b');
    expect(r.revision).toBe(s.revision + 1);
    const u = run(r, { type: 'undo' });
    expect(u.detections.find((d) => d.id === 'a')?.status).toBe('draft');
    expect(u.currentId).toBe('a');
    expect(canRedo(u)).toBe(true);
    expect(run(u, { type: 'redo' }).detections.find((d) => d.id === 'a')?.status).toBe('rejected');
  });

  it('reopen brings a rejected detection back to draft', () => {
    const s = run(loaded([det('a')]), { type: 'reject', id: 'a', by: 'D', now: NOW });
    const r = run(s, { type: 'filter', filter: 'rejected' }, { type: 'reopen', id: 'a', now: NOW });
    const a = r.detections.find((d) => d.id === 'a');
    expect(a?.status).toBe('draft');
    expect(a?.reviewedBy).toBeUndefined();
  });

  it('accepted is final: no edit, no reopen, no undo past it', () => {
    const s = run(
      loaded([det('a'), det('b', { geom: { type: 'box', x: 0, y: 500, w: 5, h: 5 } })]),
      { type: 'accepted', id: 'a', issueId: 'issue-1', by: 'D', now: NOW },
    );
    expect(s.detections.find((d) => d.id === 'a')).toMatchObject({
      status: 'accepted',
      issueId: 'issue-1',
    });
    expect(s.currentId).toBe('b');
    expect(canUndo(s)).toBe(false);
    expect(run(s, { type: 'undo' }).lastError).toBe('undo-accepted');
    expect(run(s, { type: 'edit', id: 'a', patch: { note: 'x' }, now: NOW }).lastError).toBe(
      'accepted',
    );
    expect(run(s, { type: 'reopen', id: 'a', now: NOW }).lastError).toBe('accepted');
    expect(run(s, { type: 'remove', id: 'a' }).lastError).toBe('accepted');
  });

  it('edits keep the cursor and are undoable', () => {
    const s = loaded([det('a')]);
    const e = run(s, {
      type: 'edit',
      id: 'a',
      patch: { geom: { type: 'box', x: 1, y: 2, w: 3, h: 4 }, uncertain: true, note: 'check' },
      now: '2026-10-05T11:00:00.000Z',
    });
    expect(currentOf(e)?.geom).toEqual({ type: 'box', x: 1, y: 2, w: 3, h: 4 });
    expect(currentOf(e)?.uncertain).toBe(true);
    expect(currentOf(e)?.updatedAt).toBe('2026-10-05T11:00:00.000Z');
    expect(run(e, { type: 'undo' }).detections[0]?.geom).toEqual(det('a').geom);
  });

  it('a person’s drawing can be deleted, a proposal only rejected', () => {
    const s = loaded([det('ai'), det('mine', { origin: { kind: 'human', author: 'D' } })]);
    expect(run(s, { type: 'remove', id: 'ai' }).lastError).toBe('proposal');
    const r = run(s, { type: 'remove', id: 'mine' });
    expect(r.detections.map((d) => d.id)).toEqual(['ai']);
    expect(
      run(r, { type: 'undo' })
        .detections.map((d) => d.id)
        .sort(),
    ).toEqual(['ai', 'mine']);
  });

  it('add selects a hand-drawn shape but keeps the place for model results', () => {
    const s = loaded([det('a')]);
    const drawn = run(s, {
      type: 'add',
      detections: [det('new', { origin: { kind: 'human', author: 'D' } })],
      label: 'Draw',
    });
    expect(drawn.currentId).toBe('new');
    const ai = run(s, {
      type: 'add',
      detections: [det('m1'), det('m2')],
      label: 'AI',
      run: { id: 'r2', at: NOW, images: 2, detections: 2, pass: 'ai-r2.json' },
    });
    expect(ai.currentId).toBe('a');
    expect(ai.runs).toHaveLength(1);
    expect(run(s, { type: 'add', detections: [det('a')], label: 'dup' }).lastError).toBe(
      'duplicate',
    );
  });

  it('the draft queue empties when everything is decided', () => {
    const s = run(loaded([det('a')]), { type: 'reject', id: 'a', by: 'D', now: NOW });
    expect(queueOf(s)).toEqual([]);
    expect(s.currentId).toBeNull();
    expect(run(s, { type: 'filter', filter: 'all' }).currentId).toBe('a');
  });

  it('reopens an accepted detection only when its issue is gone', () => {
    const s = run(loaded([det('a')]), {
      type: 'accepted',
      id: 'a',
      issueId: 'i1',
      by: 'D',
      now: NOW,
    });
    const r = run(
      s,
      { type: 'filter', filter: 'all' },
      { type: 'reopen', id: 'a', now: NOW, issueGone: true },
    );
    const a = r.detections.find((d) => d.id === 'a');
    expect(a?.status).toBe('draft');
    expect(a?.issueId).toBeUndefined();
  });
});
