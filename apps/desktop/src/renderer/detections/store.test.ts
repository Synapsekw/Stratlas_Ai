// @vitest-environment jsdom
/**
 * `acceptByIds`, the detections the assistant accepts before placing them on a model: waiting
 * ones become draft issues in one editor step, accepted ones answer their issue, and the rest
 * (rejected, or ids the review does not have) come back as skipped.
 */
import { issueEditor, setAnnotateReadOnly } from '@aio/annotate';
import { initialReview, reviewReducer, type Detection } from '@aio/annotate/detections';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// the app's bridge binds to window.aio when its module loads: answer every write with ok
vi.hoisted(() => {
  (globalThis as { aio?: unknown }).aio = {
    invoke: () => Promise.resolve({ ok: true }),
    on: () => () => undefined,
  };
});

import { acceptByIds, detections, sampledTimes } from './store';

const NOW = '2026-10-15T10:00:00.000Z';

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
  severityModels: [
    {
      id: 'sev',
      name: 'Kit',
      levels: [
        { value: 1, label: 'Minor', color: '#fad34b', criteria: '' },
        { value: 2, label: 'Moderate', color: '#ff7a2d', criteria: '' },
      ],
    },
  ],
  classCatalogues: [
    {
      id: 'cat',
      name: 'Kit',
      assetType: 'site',
      classes: [{ id: 'crack', label: 'Crack', color: '#aa0000', severityModel: 'sev' }],
    },
  ],
};

const det = (id: string, over: Partial<Detection> = {}): Detection => ({
  id,
  pass: 'review.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'crack',
  severity: 2,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'human', author: 'Reviewer' },
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
  setAnnotateReadOnly(false);
  workspace.getState().openProject({ id: 'p1', root: 'E:/p1', manifest }, []);
});
afterEach(() => {
  workspace.getState().closeProject();
  detections.setState({ projectId: null, review: initialReview(), readOnly: false });
});

describe('acceptByIds', () => {
  it('accepts the waiting ones in one step and answers the accepted and the rest', () => {
    review([
      det('d1'),
      det('d2'),
      det('done', { status: 'accepted', issueId: 'I9' }),
      det('no', { status: 'rejected' }),
      det('other'),
    ]);
    const r = acceptByIds(['d1', 'd2', 'done', 'no', 'missing']);
    if ('error' in r) throw new Error(r.error);
    expect(r.accepted.map((a) => a.id)).toEqual(['done', 'd1', 'd2']);
    expect(r.accepted[0]?.issueId).toBe('I9');
    expect(r.skipped).toEqual([
      { id: 'missing', problem: 'not-found' },
      { id: 'no', problem: 'not-waiting' },
    ]);
    // two new draft issues, one editor step, and the review marks them accepted
    expect(workspace.getState().issues).toHaveLength(2);
    expect(issueEditor.state.undoLabel).toMatch(/2/);
    const byId = new Map(detections.getState().review.detections.map((d) => [d.id, d]));
    expect(byId.get('d1')?.status).toBe('accepted');
    expect(byId.get('other')?.status).toBe('draft');
  });

  it('refuses on a read-only package', () => {
    review([det('d1')], true);
    expect(acceptByIds(['d1'])).toHaveProperty('error');
    expect(workspace.getState().issues).toHaveLength(0);
  });
});

describe('sampledTimes', () => {
  const header = (over: Record<string, unknown>) =>
    ({ schema: 'aio.detections/1', source: 'model', ...over }) as never;

  it('collects the sampled frame times of each walk from the passes, in seconds and in order', () => {
    expect(
      sampledTimes([
        header({ layer: 'w', assessed: ['t:2000', 't:0', 't:1000'] }),
        header({ layer: 'w', assessed: ['t:1000', 't:1500'] }),
        header({ layer: 'v', assessed: ['t:500'] }),
        // photo passes, and passes without a layer or a list, name no frames
        header({ layer: 'photos', assessed: ['p001'] }),
        header({ assessed: ['t:300'] }),
        header({ layer: 'x', assessed: 'all' }),
      ]),
    ).toEqual({ w: [0, 1, 1.5, 2], v: [0.5] });
  });
});
