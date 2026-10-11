import type { JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  chipState,
  drawerProject,
  needsAttention,
  projectJobs,
  projectLabel,
  runningElsewhere,
  shownJob,
  type ProjectJobs,
} from './model';

const A = 'D:\\Sites\\A';
const B = 'D:\\Sites\\B';

let n = 0;
const job = (over: Partial<JobRecord>): JobRecord => ({
  id: `job-${String(++n)}`,
  pipeline: 'system.selftest',
  project: A,
  status: 'done',
  progress: 1,
  params: {},
  steps: [],
  artifacts: [],
  createdAt: '2026-10-11T08:00:00.000Z',
  updatedAt: '2026-10-11T08:05:00.000Z',
  ...over,
});

const none: ProjectJobs = { running: [], finished: [] };

describe('a project and its jobs', () => {
  it('splits the open project into running and finished and leaves the others out', () => {
    const run = job({ status: 'running', progress: 0.4 });
    const done = job({});
    const other = job({ project: B, status: 'running' });
    expect(projectJobs([run, done, other], A)).toEqual({ running: [run], finished: [done] });
  });

  it('knows the same folder under another spelling', () => {
    const j = job({ project: 'd:/sites/a/' });
    expect(projectJobs([j], A).finished).toEqual([j]);
  });

  it('has nothing without a project', () => {
    expect(projectJobs([job({})], null)).toEqual(none);
  });

  it('lists what runs in other projects, never the finished and never a map pack build', () => {
    const elsewhere = job({ project: B, status: 'running' });
    const pack = job({
      project: 'D:\\Data\\packs\\work',
      pipeline: 'packs.imagery',
      status: 'running',
    });
    const all = [job({ status: 'running' }), job({ project: B }), elsewhere, pack];
    expect(runningElsewhere(all, A)).toEqual([elsewhere]);
  });

  it('counts every running project job as elsewhere when no project is open', () => {
    const a = job({ status: 'starting' });
    const b = job({ project: B, status: 'cancelling' });
    expect(runningElsewhere([a, b], null)).toEqual([a, b]);
  });
});

describe('what needs a look', () => {
  const start = '2026-10-11T07:00:00.000Z';

  it('leaves a failure from before this session alone', () => {
    const old = job({ status: 'failed', updatedAt: '2026-10-04T10:00:00.000Z' });
    expect(needsAttention([old], { start, seenAt: null })).toEqual([]);
  });

  it('marks a failure of this session until the drawer was opened after it', () => {
    const failed = job({ status: 'failed', updatedAt: '2026-10-11T09:00:00.000Z' });
    expect(needsAttention([failed], { start, seenAt: null })).toEqual([failed]);
    expect(needsAttention([failed], { start, seenAt: '2026-10-11T08:30:00.000Z' })).toEqual([
      failed,
    ]);
    expect(needsAttention([failed], { start, seenAt: '2026-10-11T09:30:00.000Z' })).toEqual([]);
  });

  it('marks an interrupted job at start, whenever it was interrupted, until it is looked at', () => {
    const cut = job({ status: 'interrupted', updatedAt: '2026-10-11T06:59:00.000Z' });
    expect(needsAttention([cut], { start, seenAt: null })).toEqual([cut]);
    expect(needsAttention([cut], { start, seenAt: '2026-10-11T07:10:00.000Z' })).toEqual([]);
  });

  it('marks an interrupted job again when it is interrupted again after the last look', () => {
    const cutAgain = job({ status: 'interrupted', updatedAt: '2026-10-11T08:00:00.000Z' });
    expect(needsAttention([cutAgain], { start, seenAt: '2026-10-11T07:30:00.000Z' })).toEqual([
      cutAgain,
    ]);
  });

  it('does not mark a failure that ended at the very moment of the last look', () => {
    const failed = job({ status: 'failed', updatedAt: '2026-10-11T08:00:00.000Z' });
    expect(needsAttention([failed], { start, seenAt: '2026-10-11T08:00:00.000Z' })).toEqual([]);
  });

  it('never marks a job that is done or was cancelled', () => {
    const later = '2026-10-11T09:00:00.000Z';
    const all = [job({ updatedAt: later }), job({ status: 'cancelled', updatedAt: later })];
    expect(needsAttention(all, { start, seenAt: null })).toEqual([]);
  });
});

describe('the chip', () => {
  const running = (progress: number) => job({ status: 'running', progress });

  it('is idle in a project with nothing running', () => {
    expect(chipState({ own: true, mine: none, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'idle',
    });
  });

  it('shows the percent of the one running job', () => {
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'one',
      pct: 40,
    });
  });

  it('counts several running jobs', () => {
    const mine = { running: [running(0.1), running(0.2), running(0.3)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'many',
      count: 3,
    });
  });

  it('puts what needs attention before what runs', () => {
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 0, attention: 1 })).toEqual({
      kind: 'attention',
      count: 1,
    });
  });

  it('points elsewhere only when nothing runs here', () => {
    expect(chipState({ own: true, mine: none, elsewhere: 2, attention: 0 })).toEqual({
      kind: 'elsewhere',
      count: 2,
    });
    const mine = { running: [running(0.4)], finished: [] };
    expect(chipState({ own: true, mine, elsewhere: 2, attention: 0 })).toEqual({
      kind: 'one',
      pct: 40,
    });
  });

  it('hides without a project of its own, unless something runs elsewhere', () => {
    expect(chipState({ own: false, mine: none, elsewhere: 0, attention: 0 })).toEqual({
      kind: 'hidden',
    });
    expect(chipState({ own: false, mine: none, elsewhere: 1, attention: 0 })).toEqual({
      kind: 'elsewhere',
      count: 1,
    });
  });
});

describe('the name of another project', () => {
  it('uses the library name of the folder, else the folder name', () => {
    const library = [{ name: 'North quarry', path: 'D:/Sites/B' }];
    expect(projectLabel(B, library)).toBe('North quarry');
    expect(projectLabel('D:\\Sites\\C\\', library)).toBe('C');
  });
});

describe('the project named at the top of the drawer', () => {
  const library = [{ name: 'North quarry', path: 'D:/Sites/B' }];

  it('is the open project while its own list or job shows', () => {
    expect(drawerProject(undefined, A, 'Site A', library)).toBe('Site A');
    expect(drawerProject(job({ project: 'd:/sites/a/' }), A, 'Site A', library)).toBe('Site A');
  });

  it('is the project of a shown job that belongs to another project', () => {
    expect(drawerProject(job({ project: B, status: 'running' }), A, 'Site A', library)).toBe(
      'North quarry',
    );
    expect(drawerProject(job({ project: B, status: 'running' }), null, null, library)).toBe(
      'North quarry',
    );
  });

  it('is nothing with no project of its own and no job', () => {
    expect(drawerProject(undefined, null, null, library)).toBeNull();
  });
});

describe('the job whose details show', () => {
  it('is the picked job of the open project', () => {
    const mine = job({});
    expect(shownJob([mine], mine.id, A)).toBe(mine);
  });

  it('is a picked job of another project only while it runs', () => {
    const running = job({ project: B, status: 'running' });
    const done = job({ project: B });
    expect(shownJob([running, done], running.id, A)).toBe(running);
    expect(shownJob([running, done], done.id, A)).toBeUndefined();
    expect(shownJob([running, done], running.id, null)).toBe(running);
  });

  it('is none when nothing is picked or the picked job is gone', () => {
    expect(shownJob([job({})], null, A)).toBeUndefined();
    expect(shownJob([job({})], 'job-gone', A)).toBeUndefined();
  });
});
