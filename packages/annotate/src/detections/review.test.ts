import { describe, expect, it } from 'vitest';
import type { Detection } from './model';
import {
  canRedo,
  canUndo,
  currentOf,
  detectorThreshold,
  initialReview,
  inQueue,
  isDetectorDraft,
  passDefaultBars,
  queueOf,
  REJECT_NOTE_MAX,
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

describe('custom fields on drafts', () => {
  it('a fields patch is undoable', () => {
    const s = loaded([det('a')]);
    const fields = [
      { key: 'reading', label: 'Reading', type: 'number' as const, value: 3, unit: 'bar' },
    ];
    const e = run(s, { type: 'edit', id: 'a', patch: { fields }, now: NOW });
    expect(currentOf(e)?.fields).toEqual(fields);
    expect(run(e, { type: 'undo' }).detections[0]?.fields).toBeUndefined();
  });
});

describe('detector drafts and per-pass thresholds', () => {
  const detector = {
    id: 'corrosion-spike',
    version: 2,
    modelSha256: 'a'.repeat(64),
    threshold: 0.6,
  };
  const vlm = (id: string, over: Partial<Detection> = {}) =>
    det(id, {
      pass: 'vlm-run-a.json',
      origin: { kind: 'model', producer: 'qwen', detector },
      ...over,
    });
  const setBar = (value: number): ReviewAction => ({
    type: 'passThreshold',
    pass: 'vlm-run-a.json',
    value,
  });

  it('a draft under the pass threshold is hidden and shown when the threshold drops', () => {
    let s = loaded([vlm('a', { confidence: 0.5 }), vlm('b', { confidence: 0.9 })]);
    // the origin threshold (0.6) holds until the reviewer sets one for the pass
    expect(queueOf(s).map((d) => d.id)).toEqual(['b']);
    s = run(s, setBar(0.95));
    expect(queueOf(s)).toEqual([]);
    s = run(s, setBar(0.3));
    expect(queueOf(s).map((d) => d.id)).toEqual(['a', 'b']);
    expect(detectorThreshold(s, vlm('a'))).toBe(0.3);
  });

  it('unscored drafts are never hidden by a pass threshold', () => {
    const s = run(loaded([vlm('u', { unscored: true, confidence: 0.1 })]), setBar(1));
    expect(queueOf(s).map((d) => d.id)).toEqual(['u']);
  });

  it('unscored drafts are not hidden by the general minimum confidence either', () => {
    let s = loaded([vlm('u', { unscored: true, confidence: 0.1 })]);
    s = run(s, { type: 'minConfidence', value: 0.9 });
    expect(queueOf(s).map((d) => d.id)).toEqual(['u']);
  });

  it('human and cloud AI drafts ignore pass thresholds', () => {
    const human = det('h', { origin: { kind: 'human', author: 'me' }, confidence: 0.1 });
    const cloud = det('c', { confidence: 0.1 });
    const s = run(loaded([human, cloud]), {
      type: 'passThreshold',
      pass: 'ai-r1.json',
      value: 0.9,
    });
    expect(queueOf(s).map((d) => d.id)).toEqual(['c', 'h']);
    expect(detectorThreshold(s, cloud)).toBeNull();
    expect(isDetectorDraft(cloud)).toBe(false);
    expect(isDetectorDraft(vlm('a'))).toBe(true);
  });

  it('the first edit of a detector draft keeps the proposed box; later edits do not move it', () => {
    const move = (x: number, w: number): ReviewAction => ({
      type: 'edit',
      id: 'a',
      now: NOW,
      patch: { geom: { type: 'box', x, y: 10, w, h: 40 } },
    });
    let s = run(loaded([vlm('a')]), move(20, 50));
    expect(s.detections[0]?.proposedBox).toEqual([10, 10, 60, 50]);
    s = run(s, move(30, 10));
    expect(s.detections[0]?.proposedBox).toEqual([10, 10, 60, 50]);
    // a note edit moves no box; other origins record nothing
    const note = run(loaded([vlm('a')]), { type: 'edit', id: 'a', now: NOW, patch: { note: 'x' } });
    expect(note.detections[0]?.proposedBox).toBeUndefined();
    const cloud = run(loaded([det('a')]), move(20, 50));
    expect(cloud.detections[0]?.proposedBox).toBeUndefined();
  });

  it('reject keeps the reason and note', () => {
    const s = run(loaded([vlm('a')]), {
      type: 'reject',
      id: 'a',
      by: 'me',
      now: NOW,
      reason: 'wrong-class',
      note: 'looks like paint',
    });
    expect(s.detections[0]).toMatchObject({
      status: 'rejected',
      rejectReason: 'wrong-class',
      rejectNote: 'looks like paint',
    });
    const plain = run(loaded([vlm('a')]), { type: 'reject', id: 'a', by: 'me', now: NOW });
    expect(plain.detections[0]?.rejectReason).toBeUndefined();
  });
  it('a reopen drops the reason and note; a later reject without them keeps none', () => {
    const reject = (over: Partial<Extract<ReviewAction, { type: 'reject' }>> = {}) =>
      ({ type: 'reject', id: 'a', by: 'me', now: NOW, ...over }) as ReviewAction;
    let s = run(loaded([vlm('a')]), reject({ reason: 'wrong-class', note: 'paint' }));
    s = run(s, { type: 'reopen', id: 'a', now: NOW });
    expect(s.detections[0]?.rejectReason).toBeUndefined();
    expect(s.detections[0]?.rejectNote).toBeUndefined();
    s = run(s, reject());
    expect(s.detections[0]?.status).toBe('rejected');
    expect(s.detections[0]).not.toHaveProperty('rejectReason');
    expect(s.detections[0]).not.toHaveProperty('rejectNote');
  });

  it('accepting a rejected detection drops its reason and note', () => {
    let s = run(loaded([vlm('a'), vlm('b')]), {
      type: 'reject',
      id: 'a',
      by: 'me',
      now: NOW,
      reason: 'box-wrong',
      note: 'twice',
    });
    s = run(s, { type: 'accepted', id: 'a', issueId: 'i1', by: 'me', now: NOW });
    expect(s.detections.find((d) => d.id === 'a')).not.toHaveProperty('rejectReason');
    expect(s.detections.find((d) => d.id === 'a')).not.toHaveProperty('rejectNote');
    const many = run(
      loaded([vlm('b', { status: 'rejected', rejectReason: 'box-wrong', rejectNote: 'x' })]),
      {
        type: 'acceptedMany',
        items: [{ id: 'b', issueId: 'i2' }],
        label: 'all',
        by: 'me',
        now: NOW,
      },
    );
    expect(many.detections[0]).not.toHaveProperty('rejectReason');
    expect(many.detections[0]).not.toHaveProperty('rejectNote');
  });

  it('a reject note is cut to 200 characters', () => {
    const s = run(loaded([vlm('a')]), {
      type: 'reject',
      id: 'a',
      by: 'me',
      now: NOW,
      note: 'x'.repeat(250),
    });
    expect(REJECT_NOTE_MAX).toBe(200);
    expect(s.detections[0]?.rejectNote).toHaveLength(200);
  });

  it('without a slider value a pass uses its lowest detector bar, the value its row shows', () => {
    const other = { ...detector, id: 'rust-streak', threshold: 0.8 };
    const low = vlm('low', { confidence: 0.7 });
    const high = vlm('high', {
      confidence: 0.7,
      origin: { kind: 'model', producer: 'qwen', detector: other },
    });
    const s = loaded([low, high]);
    expect(passDefaultBars(s.detections).get('vlm-run-a.json')).toBe(0.6);
    // the 0.8 detector's draft scored 0.7 is not hidden by a bar the row shows as 0.6
    expect(detectorThreshold(s, high)).toBe(0.6);
    expect(
      queueOf(s)
        .map((d) => d.id)
        .sort(),
    ).toEqual(['high', 'low']);
    expect(inQueue(high, 'draft', 0, {}, s.detections)).toBe(true);
    // a bar outside the slider's ends is held at the nearest end, as the row shows it
    const steep = vlm('s', {
      confidence: 0.96,
      origin: { kind: 'model', producer: 'qwen', detector: { ...detector, threshold: 0.99 } },
    });
    expect(queueOf(loaded([steep])).map((d) => d.id)).toEqual(['s']);
  });
});
