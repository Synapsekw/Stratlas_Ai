// @vitest-environment jsdom
/**
 * A pipeline reads issues.json and the detection passes from disk, and both are written late (the
 * issue saver about 0.6 s after a change, the detections store 0.5 s). Every job start of the
 * window goes through `createBridge`, so these tests drive the real savers, the real `bridge` and
 * the real jobs store over a recording `window.aio`.
 */
import type { Detection } from '@aio/annotate/detections';
import type { Issue, JobRecord } from '@aio/schema';
import { workspace, type OpenProject } from '@aio/workspace';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = '2026-10-05T10:00:00.000Z';

const fake = vi.hoisted(() => {
  const state = {
    /** Channels in the order main was asked, with `:done` when a write had answered. */
    log: [] as string[],
    issuesAnswer: { ok: true } as { ok: boolean; error?: string },
    /** The issue ids of every `project:writeIssues`, in order. */
    written: [] as string[][],
    detectionsAnswer: { ok: true } as { ok: boolean; error?: string },
  };
  const later = <T>(value: T) =>
    new Promise<T>((r) => {
      setTimeout(() => {
        r(value);
      }, 5);
    });
  const invoke = async (channel: string, req?: unknown): Promise<unknown> => {
    if (channel === 'project:writeIssues') {
      state.log.push(channel);
      state.written.push((req as { issues: { id: string }[] }).issues.map((i) => i.id));
      const answer = await later(state.issuesAnswer);
      state.log.push(`${channel}:done`);
      return answer;
    }
    if (channel === 'detections:write') {
      state.log.push(channel);
      const answer = await later(state.detectionsAnswer);
      state.log.push(`${channel}:done`);
      return answer;
    }
    if (channel === 'jobs:start') {
      state.log.push(channel);
      return {
        ok: true,
        job: {
          id: 'j1',
          pipeline: 'inspection.run',
          project: 'E:\\p',
          params: {},
          status: 'running',
          progress: 0,
          steps: [],
          artifacts: [],
          createdAt: '2026-10-05T10:00:00.000Z',
          updatedAt: '2026-10-05T10:00:00.000Z',
        } satisfies JobRecord,
      };
    }
    return {};
  };
  (globalThis as { aio?: unknown }).aio = { invoke, on: () => () => undefined };
  return state;
});

import { issueSaver, setAnnotateReadOnly } from '@aio/annotate';
import { detections, dispatch, flushDetections } from './detections/store';
import { bridge, jobs } from './shell';

const START = { pipeline: 'inspection.run', project: 'E:\\p', params: {} } as const;

const drawn = (id: string): Detection => ({
  id,
  pass: 'review.json',
  source: { kind: 'photo', layer: 'photos', photo: 'p001' },
  size: [1000, 800],
  geom: { type: 'box', x: 10, y: 10, w: 50, h: 40 },
  classId: 'moderate',
  severity: 2,
  uncertain: false,
  note: '',
  status: 'draft',
  origin: { kind: 'human', author: 'Reviewer' },
  createdAt: NOW,
  updatedAt: NOW,
});

/** The open project, as far as the savers look at it. */
const OPEN = { id: 'p1', root: 'E:\\p', manifest: { layers: [] } } as unknown as OpenProject;
const F01 = { id: 'F01' } as unknown as Issue;
const REFUSED = { ok: false, error: 'Could not save issues.json: EPERM' };
const PASS_REFUSED = { ok: false, error: 'Could not save review.json: EPERM' };

let n = 0;
beforeEach(async () => {
  // leave nothing queued from the test before
  fake.issuesAnswer = { ok: true };
  fake.detectionsAnswer = { ok: true };
  setAnnotateReadOnly(false);
  workspace.setState({ project: OPEN, issues: [F01] });
  issueSaver.schedule('p1', [] as Issue[]);
  await issueSaver.flush();
  detections.setState({ projectId: 'p1', readOnly: false });
  dispatch({ type: 'add', detections: [drawn(`reset-${++n}`)], label: 'Draw' });
  await flushDetections();
  fake.log.length = 0;
  fake.written.length = 0;
});

describe('a job start while saves are pending', () => {
  it('writes the queued issues before main is asked to start', async () => {
    issueSaver.schedule('p1', [] as Issue[]);
    expect(issueSaver.status.state).toBe('pending');
    const r = await bridge.call('jobs:start', START);
    expect(r.ok).toBe(true);
    expect(fake.log).toEqual(['project:writeIssues', 'project:writeIssues:done', 'jobs:start']);
  });

  it('writes the changed detection pass before main is asked to start', async () => {
    dispatch({ type: 'add', detections: [drawn('d-pass')], label: 'Draw' });
    expect(detections.getState().save.state).toBe('pending');
    const r = await bridge.call('jobs:start', START);
    expect(r.ok).toBe(true);
    expect(fake.log).toEqual(['detections:write', 'detections:write:done', 'jobs:start']);
  });

  it('covers a start through the jobs store, with both savers pending', async () => {
    issueSaver.schedule('p1', [] as Issue[]);
    dispatch({ type: 'add', detections: [drawn('d-both')], label: 'Draw' });
    expect(await jobs.getState().start(START)).toBeNull();
    expect(fake.log.at(-1)).toBe('jobs:start');
    expect(fake.log.filter((c) => c.endsWith(':done'))).toEqual([
      'project:writeIssues:done',
      'detections:write:done',
    ]);
  });

  it('starts at once when nothing is pending', async () => {
    expect((await bridge.call('jobs:start', START)).ok).toBe(true);
    expect(fake.log).toEqual(['jobs:start']);
  });

  it('does not start when the issues could not be saved, and says why', async () => {
    fake.issuesAnswer = REFUSED;
    issueSaver.schedule('p1', [] as Issue[]);
    const error = await jobs.getState().start(START);
    expect(error).toContain('Could not save issues.json: EPERM');
    expect(error).toMatch(/not started/);
    expect(fake.log).not.toContain('jobs:start');
    // the save status the register shows is the saver's own
    expect(issueSaver.status).toMatchObject({ state: 'error' });
  });

  it('does not start when a detection pass could not be saved, and says why', async () => {
    fake.detectionsAnswer = PASS_REFUSED;
    dispatch({ type: 'add', detections: [drawn('d-refused')], label: 'Draw' });
    const r = await bridge.call('jobs:start', START);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('Could not save review.json: EPERM');
    expect(fake.log).not.toContain('jobs:start');
    expect(detections.getState().save.state).toBe('error');
  });
});

describe('a job start after a save that failed earlier', () => {
  /** An issue save that failed a while ago: nothing queued, the status says "Not saved". */
  async function issuesFailedEarlier() {
    fake.issuesAnswer = REFUSED;
    issueSaver.schedule('p1', [] as Issue[]);
    await issueSaver.flush();
    expect(issueSaver.status.state).toBe('error');
    fake.log.length = 0;
    fake.written.length = 0;
  }

  /** The same for a detection pass. */
  async function passFailedEarlier(id: string) {
    fake.detectionsAnswer = PASS_REFUSED;
    dispatch({ type: 'add', detections: [drawn(id)], label: 'Draw' });
    await flushDetections();
    expect(detections.getState().save.state).toBe('error');
    fake.log.length = 0;
  }

  it('writes the issues once more, starts the job and clears "Not saved"', async () => {
    await issuesFailedEarlier();
    fake.issuesAnswer = { ok: true };
    expect(await jobs.getState().start(START)).toBeNull();
    expect(fake.log).toEqual(['project:writeIssues', 'project:writeIssues:done', 'jobs:start']);
    // the list as it stands now, not the one that failed
    expect(fake.written).toEqual([['F01']]);
    expect(issueSaver.status.state).toBe('saved');
  });

  it('does not start when the issues still cannot be saved, and says why', async () => {
    await issuesFailedEarlier();
    const error = await jobs.getState().start(START);
    expect(error).toContain('Could not save issues.json: EPERM');
    expect(error).toMatch(/not started/);
    // one try at the start, no more
    expect(fake.log).toEqual(['project:writeIssues', 'project:writeIssues:done']);
    expect(issueSaver.status.state).toBe('error');
  });

  it('writes the detection pass once more, starts the job and clears "Not saved"', async () => {
    await passFailedEarlier('d-again');
    fake.detectionsAnswer = { ok: true };
    expect((await bridge.call('jobs:start', START)).ok).toBe(true);
    expect(fake.log).toEqual(['detections:write', 'detections:write:done', 'jobs:start']);
    expect(detections.getState().save.state).toBe('saved');
  });

  it('does not start when the pass still cannot be saved, and says why', async () => {
    await passFailedEarlier('d-still');
    const r = await bridge.call('jobs:start', START);
    expect(!r.ok && r.error).toContain('Could not save review.json: EPERM');
    expect(!r.ok && r.error).toMatch(/not started/);
    expect(fake.log).toEqual(['detections:write', 'detections:write:done']);
    expect(detections.getState().save.state).toBe('error');
  });

  it('does not hold a job back for a failed save it has nothing left to write for', async () => {
    await issuesFailedEarlier();
    // the project is closed, or a read-only package: there is no list to write again
    workspace.setState({ project: null, issues: [] });
    expect((await bridge.call('jobs:start', START)).ok).toBe(true);
    workspace.setState({ project: OPEN, issues: [F01] });
    setAnnotateReadOnly(true);
    expect((await bridge.call('jobs:start', START)).ok).toBe(true);
    expect(fake.log).toEqual(['jobs:start', 'jobs:start']);
  });
});
