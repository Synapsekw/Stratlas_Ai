import type { ImportItem } from '@aio/schema';
import { clearToasts, toastQueue } from '@aio/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: { importResult: null as { items: ImportItem[]; error: string | null } | null },
  root: 'E:/p',
}));
vi.mock('../builder/state', () => ({
  builder: {
    getState: () => h.state,
    setState: (p: Partial<typeof h.state>) => Object.assign(h.state, p),
  },
}));
vi.mock('@aio/workspace', () => ({
  workspace: { getState: () => ({ project: { root: h.root } }) },
}));

import { applyLaneNotice, onLaneNotice } from './queueWatch';

const waiting = (file: string): ImportItem => ({
  file,
  kind: 'flyability',
  status: 'queued',
  message: 'Waits for the chamber before it, then converts.',
});

beforeEach(() => {
  clearToasts();
  h.root = 'E:/p';
  h.state.importResult = { items: [waiting('Chamber A'), waiting('Chamber B')], error: null };
});

describe('lane notices on the import card', () => {
  it('a chamber that starts gets its job and says it converts', () => {
    const items = applyLaneNotice(h.state.importResult?.items ?? [], {
      project: 'E:/p',
      src: 'D:/m/Chamber B',
      state: 'started',
      jobId: 'job-b',
    });
    expect(items?.[1]).toMatchObject({ status: 'queued', jobId: 'job-b' });
    expect(items?.[1]?.message).toBe('Converting with the processing tools.');
    expect(items?.[0]?.jobId).toBeUndefined();
  });

  it('a dropped chamber says it was not imported; a failed one why', () => {
    const items = applyLaneNotice(h.state.importResult?.items ?? [], {
      project: 'E:/p',
      src: 'D:/m/Chamber A',
      state: 'dropped',
      reason: 'cancelled',
    });
    expect(items?.[0]).toMatchObject({
      status: 'skipped',
      message: 'Not imported: an Inspector import of this project was cancelled.',
    });
    const failed = applyLaneNotice(items ?? [], {
      project: 'E:/p',
      src: 'D:\\m\\Chamber B',
      state: 'failed',
      error: 'no pack',
    });
    expect(failed?.[1]).toMatchObject({ status: 'error', message: 'Did not start: no pack' });
  });

  it('changes the card of the open project only, and a failure is also a toast', () => {
    onLaneNotice({ project: 'E:/other', src: 'D:/m/Chamber A', state: 'failed', error: 'x' });
    expect(h.state.importResult?.items[0]?.status).toBe('queued');
    expect(toastQueue()).toHaveLength(1);
    onLaneNotice({ project: 'e:\\p', src: 'D:/m/Chamber A', state: 'failed', error: 'x' });
    expect(h.state.importResult?.items[0]?.status).toBe('error');
  });
});
