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
  workspace: { getState: () => ({ project: { id: 'p1', root: h.root } }) },
}));

import { applyLaneNotice, onJobUpdate, onLaneNotice, setSpacesReload } from './queueWatch';

const waiting = (file: string, inspection: string): ImportItem => ({
  file,
  kind: 'flyability',
  status: 'queued',
  message: 'Waits for the chamber before it, then converts.',
  inspections: [inspection],
});
const row = (k: number) => h.state.importResult?.items[k];

beforeEach(() => {
  clearToasts();
  h.root = 'E:/p';
  // two chambers in folders of one name
  h.state.importResult = {
    items: [waiting('Export', 'i-a'), waiting('Export', 'i-b')],
    error: null,
  };
});

describe('lane notices on the import card', () => {
  it('a chamber that starts gets its job; rows are told apart by inspection', () => {
    const items = applyLaneNotice(h.state.importResult?.items ?? [], {
      project: 'E:/p',
      src: 'D:/m/Day 2/Export',
      inspections: ['i-b'],
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
      src: 'D:/m/Day 1/Export',
      inspections: ['i-a'],
      state: 'dropped',
      reason: 'cancelled',
    });
    expect(items?.[0]).toMatchObject({
      status: 'skipped',
      message: 'Not imported: an Inspector import of this project was cancelled.',
    });
    const failed = applyLaneNotice(items ?? [], {
      project: 'E:/p',
      src: 'D:/m/Day 2/Export',
      inspections: ['i-b'],
      state: 'failed',
      error: 'no pack',
    });
    expect(failed?.[1]).toMatchObject({ status: 'error', message: 'Did not start: no pack' });
  });

  it('changes the open project card only, with one failure notice per project', () => {
    const fail = (project: string, inspection: string) => {
      onLaneNotice({
        project,
        src: 'D:/m/Export',
        inspections: [inspection],
        state: 'failed',
        error: 'no pack',
      });
    };
    fail('E:/other', 'i-a');
    expect(row(0)?.status).toBe('queued');
    fail('e:\\p', 'i-a');
    fail('E:/p', 'i-b');
    expect([row(0)?.status, row(1)?.status]).toEqual(['error', 'error']);
    // the other project's notice and one for this project, counting both chambers
    expect(toastQueue().map((x) => x.message)).toEqual([
      'A waiting chamber did not start.',
      '2 waiting chambers did not start.',
    ]);
  });

  it('a tidy of the open project reads its spaces again', () => {
    const reload = vi.fn(() => Promise.resolve());
    setSpacesReload(reload);
    onLaneNotice({ project: 'E:/other', state: 'tidied', removed: ['fly-x'] });
    expect(reload).not.toHaveBeenCalled();
    onLaneNotice({ project: 'E:/p', state: 'tidied', removed: ['fly-x'] });
    expect(reload).toHaveBeenCalledWith('p1');
  });
});

describe('chamber rows follow their jobs', () => {
  const job = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, pipeline: 'flyability.import', status, progress: 0.4, ...extra }) as never;

  it('a running chamber says so, then done, failed or cancelled; the card settles', () => {
    h.state.importResult = {
      items: [
        { ...waiting('Chamber A', 'i-a'), jobId: 'j-a' },
        { ...waiting('Chamber B', 'i-b'), jobId: 'j-b' },
      ],
      error: null,
    };
    onJobUpdate(job('j-a', 'running'));
    expect(row(0)).toMatchObject({ status: 'queued', message: 'Converting, 40 %' });
    onJobUpdate(job('j-a', 'done'));
    expect(row(0)).toMatchObject({ status: 'imported', message: 'Imported into its space.' });
    onJobUpdate(job('j-b', 'failed', { error: 'disk full' }));
    expect(row(1)).toMatchObject({ status: 'error', message: 'disk full' });
    // a failure keeps the card open, so it can be read
    expect(h.state.importResult).not.toBeNull();
    // another pipeline's job, or a job no row has, changes nothing
    onJobUpdate({ id: 'j-a', pipeline: 'pano.stitch', status: 'failed' } as never);
    expect(row(0)?.status).toBe('imported');
  });

  it('the card closes once every chamber is imported', () => {
    h.state.importResult = {
      items: [
        { ...waiting('Chamber A', 'i-a'), jobId: 'j-a' },
        { ...waiting('Chamber B', 'i-b'), jobId: 'j-b' },
      ],
      error: null,
    };
    onJobUpdate(job('j-a', 'done'));
    expect(h.state.importResult).not.toBeNull();
    onJobUpdate(job('j-b', 'done'));
    expect(h.state.importResult).toBeNull();
  });

  it('a cancelled or interrupted chamber says so', () => {
    h.state.importResult = {
      items: [
        { ...waiting('Chamber A', 'i-a'), jobId: 'j-a' },
        { ...waiting('Chamber B', 'i-b'), jobId: 'j-b' },
      ],
      error: null,
    };
    onJobUpdate(job('j-a', 'cancelled'));
    onJobUpdate(job('j-b', 'interrupted'));
    expect(row(0)).toMatchObject({ status: 'skipped', message: 'Cancelled.' });
    expect(row(1)?.status).toBe('error');
  });
});
