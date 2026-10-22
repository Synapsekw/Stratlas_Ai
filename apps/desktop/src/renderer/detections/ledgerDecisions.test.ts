// @vitest-environment jsdom
/**
 * The review store hands decisions on local-detector drafts, and hand-drawn findings, to the
 * ledger logger: accept, reject and reject all, and a drawing that a detector pass missed.
 */
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  };
});
const logReview = vi.hoisted(() =>
  vi.fn<(d: { id: string }, verdict: string, ctx: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  ),
);
const logMiss = vi.hoisted(() =>
  vi.fn<
    (
      d: { id: string },
      found: { name: string; detectors: { id: string; classId: string }[] }[],
    ) => Promise<void>
  >(() => Promise.resolve()),
);
vi.mock('./detectors/ledgerLog', () => ({ logReview, logMiss }));

import { detections, dispatch, rejectAll } from './store';

const NOW = '2026-10-22T10:00:00.000Z';
const SHA = 'a'.repeat(64);

const manifest: ProjectManifest = {
  schema: 'aio.project/1',
  id: 'p1',
  name: 'P',
  crs: { epsg: 32639 },
  origin: [0, 0, 0],
  captures: [],
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      visible: true,
      items: [{ id: 'p001', src: { path: 'photos/p001.jpg' } }],
    },
  ],
  severityModels: [],
  classCatalogues: [],
};

const cand = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'vlm-1.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'chimney',
  severity: 2,
  uncertain: false,
  note: '',
  confidence: 0.8,
  status: 'draft',
  origin: {
    kind: 'model',
    producer: 'm (local)',
    detector: { id: 'chimney', version: 1, modelSha256: SHA, threshold: 0.5 },
  },
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function review(list: Detection[], readOnly = false) {
  detections.setState({
    projectId: 'p1',
    readOnly,
    review: reviewReducer(initialReview(), { type: 'load', detections: list }),
  });
}

beforeEach(() => {
  logReview.mockClear();
  logMiss.mockClear();
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, []);
});
afterEach(() => {
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview(), readOnly: false });
});

describe('review decisions into the ledger', () => {
  it('a reject with a reason logs the rejected draft with that reason', () => {
    review([cand('a')]);
    dispatch({ type: 'reject', id: 'a', by: 'u', now: NOW, reason: 'not-a-defect', note: 'sun' });
    expect(logReview).toHaveBeenCalledTimes(1);
    const [d, verdict, ctx] = logReview.mock.calls[0] ?? [];
    expect(verdict).toBe('rejected');
    expect(d).toMatchObject({ id: 'a', rejectReason: 'not-a-defect', rejectNote: 'sun' });
    expect(ctx).toMatchObject({ projectId: 'p1', layer: 'photos' });
    expect((ctx as { photoUrl: string | null }).photoUrl).toContain('p001.jpg');
  });

  it('an accept logs the accepted draft', () => {
    review([cand('a')]);
    dispatch({ type: 'accepted', id: 'a', issueId: 'I1', by: 'u', now: NOW });
    expect(logReview).toHaveBeenCalledTimes(1);
    expect(logReview.mock.calls[0]?.[1]).toBe('accepted');
  });

  it('a batch reject logs every draft it rejected, not the ones already decided', () => {
    review([cand('a'), cand('b'), cand('c', { status: 'rejected' })]);
    expect(rejectAll(detections.getState().review.detections)).toBe(2);
    expect(logReview.mock.calls.map((c) => c[0].id).sort()).toEqual(['a', 'b']);
  });

  it('a hand-drawn finding goes to the miss log with the passes of the review', () => {
    review([cand('a')]);
    const drawn = cand('h1', {
      pass: 'review.json',
      origin: { kind: 'human', author: 'u' },
    });
    dispatch({ type: 'add', detections: [drawn], label: 'Draw' });
    expect(logMiss).toHaveBeenCalledTimes(1);
    const [d, found] = logMiss.mock.calls[0] ?? [];
    expect(d?.id).toBe('h1');
    expect(found).toHaveLength(1);
    expect(found?.[0]?.name).toBe('vlm-1.json');
    expect(found?.[0]?.detectors).toMatchObject([{ id: 'chimney', classId: 'chimney' }]);
  });

  it('a read-only package logs nothing', () => {
    review([cand('a')], true);
    dispatch({ type: 'reject', id: 'a', by: 'u', now: NOW });
    expect(logReview).not.toHaveBeenCalled();
  });
});
