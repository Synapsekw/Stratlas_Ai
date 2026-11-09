import type { IpcRequest, JobEvent, JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { inspectorLane, type LaneNotice } from './inspectorLane';

type Req = IpcRequest<'jobs:start'>;
const req = (src: string, project = 'E:/p'): Req => ({
  pipeline: 'flyability.import',
  project,
  params: { src, inspections: [{ id: src }] },
});
const job = (id: string, status: JobRecord['status'], project = 'E:/p') =>
  ({ id, pipeline: 'flyability.import', status, project, params: {} }) as unknown as JobRecord;
const ended = (id: string, status: JobRecord['status'] = 'done', project = 'E:/p'): JobEvent => ({
  type: 'update',
  job: job(id, status, project),
});

function setup(busyOutside = false) {
  const started: Req[] = [];
  let outside = busyOutside;
  const lane = inspectorLane({
    start: (r) => {
      started.push(r);
      return Promise.resolve({ ok: true, job: job(`job-${String(started.length)}`, 'starting') });
    },
    busy: () => Promise.resolve(outside),
  });
  return {
    lane,
    started,
    free: () => {
      outside = false;
    },
  };
}

describe('inspectorLane', () => {
  it('runs one Inspector import at a time, first in first out', async () => {
    const t = setup();
    expect(await t.lane.start(req('A'))).toMatchObject({ ok: true, job: { id: 'job-1' } });
    expect(await t.lane.start(req('B'))).toEqual({ ok: true, queued: true });
    expect(await t.lane.start(req('C'))).toEqual({ ok: true, queued: true });
    expect(t.started).toHaveLength(1);
    expect(t.lane.waiting()).toHaveLength(2);
    // another pipeline's job ending moves nothing
    await t.lane.settled({ type: 'update', job: { ...job('x', 'done'), pipeline: 'pano.stitch' } });
    expect(t.started).toHaveLength(1);
    await t.lane.settled(ended('job-1', 'failed'));
    expect(t.started.map((r) => ('params' in r ? r.params.src : null))).toEqual(['A', 'B']);
    await t.lane.settled(ended('job-2', 'failed'));
    expect(t.started).toHaveLength(3);
    await t.lane.settled(ended('job-3'));
    expect(t.lane.waiting()).toHaveLength(0);
    expect(t.lane.running()).toBeNull();
  });

  it('waits for an Inspector import started elsewhere (the Processing drawer)', async () => {
    const t = setup(true);
    expect(await t.lane.start(req('A'))).toEqual({ ok: true, queued: true });
    t.free();
    await t.lane.settled(ended('manual'));
    expect(t.started).toHaveLength(1);
  });

  it('a waiting import that cannot start is logged and the next one goes', async () => {
    const lines: string[] = [];
    let n = 0;
    const lane = inspectorLane({
      start: () => {
        n++;
        return Promise.resolve(
          n === 2
            ? { ok: false as const, error: 'no pack' }
            : { ok: true as const, job: job(`job-${String(n)}`, 'starting') },
        );
      },
      busy: () => Promise.resolve(false),
      log: (l) => lines.push(l),
    });
    await lane.start(req('A'));
    await lane.start(req('B'));
    await lane.start(req('C'));
    await lane.settled(ended('job-1'));
    expect(n).toBe(3);
    expect(lines.join('\n')).toContain('no pack');
    expect(lane.running()).toBe('job-3');
  });

  function full(resumable: Record<string, string[]> = {}, removes: string[] = []) {
    const started: Req[] = [];
    const notices: LaneNotice[] = [];
    const tidied: [string, string[]][] = [];
    let fail: string | null = null;
    const lane = inspectorLane({
      start: (r) => {
        started.push(r);
        if (fail !== null) return Promise.resolve({ ok: false as const, error: fail });
        const project = 'project' in r ? r.project : 'E:/p';
        return Promise.resolve({
          ok: true as const,
          job: job(`job-${String(started.length)}`, 'starting', project),
        });
      },
      busy: () => Promise.resolve(false),
      notify: (n) => notices.push(n),
      tidy: (project, keep) => {
        tidied.push([project, [...keep].sort()]);
        return Promise.resolve({ removed: removes, changed: removes.length > 0 });
      },
      resumable: (project) => resumable[project] ?? [],
      record: (id) =>
        id === 'old'
          ? { project: 'E:/p', params: { src: 'R', inspections: [{ id: 'R' }] } }
          : undefined,
    });
    return {
      lane,
      started,
      notices,
      tidied,
      failNext: (e: string | null) => {
        fail = e;
      },
    };
  }

  it('a cancelled chamber drops the waiting chambers of its project, and tidies their spaces', async () => {
    const t = full();
    await t.lane.start(req('A'));
    await t.lane.start(req('B'));
    await t.lane.start(req('C'));
    await t.lane.start(req('D', 'E:/q'));
    await t.lane.settled(ended('job-1', 'cancelled'));
    expect(t.notices).toEqual([
      { project: 'E:/p', src: 'B', inspections: ['B'], state: 'dropped', reason: 'cancelled' },
      { project: 'E:/p', src: 'C', inspections: ['C'], state: 'dropped', reason: 'cancelled' },
      { project: 'E:/q', src: 'D', inspections: ['D'], state: 'started', jobId: 'job-2' },
    ]);
    // the other project's chamber goes on
    expect(t.started.map((r) => ('params' in r ? r.params.src : ''))).toEqual(['A', 'D']);
    expect(t.tidied).toContainEqual(['E:/p', []]);
  });

  it('a project closed or deleted drops its waiting chambers; the running one keeps its space', async () => {
    const t = full();
    await t.lane.start(req('A'));
    await t.lane.start(req('B'));
    // the same folder written another way still matches (Windows paths)
    const other = process.platform === 'win32' ? 'e:\\p' : 'E:/p';
    await t.lane.cancelProject(other);
    expect(t.notices).toEqual([
      { project: 'E:/p', src: 'B', inspections: ['B'], state: 'dropped', reason: 'closed' },
    ]);
    expect(t.lane.waiting()).toHaveLength(0);
    expect(t.tidied).toEqual([[other, ['A']]]);
  });

  it('a chamber that cannot start says why, and the next one goes', async () => {
    const t = full();
    await t.lane.start(req('A'));
    await t.lane.start(req('B'));
    await t.lane.start(req('C'));
    t.failNext('no pack');
    await t.lane.settled(ended('job-1'));
    expect(t.notices).toContainEqual({
      project: 'E:/p',
      src: 'B',
      inspections: ['B'],
      state: 'failed',
      error: 'no pack',
    });
    expect(t.notices).toContainEqual({
      project: 'E:/p',
      src: 'C',
      inspections: ['C'],
      state: 'failed',
      error: 'no pack',
    });
  });

  it('a resume waits in the same line', async () => {
    const t = full();
    await t.lane.start(req('A'));
    expect(await t.lane.start({ resume: 'old' })).toEqual({ ok: true, queued: true });
    await t.lane.settled(ended('job-1'));
    expect(t.started[1]).toEqual({ resume: 'old' });
    expect(t.notices).toContainEqual({
      project: 'E:/p',
      src: 'R',
      inspections: ['R'],
      state: 'started',
      jobId: 'job-2',
    });
  });
});

describe('inspectorLane tidy', () => {
  function lane(resumable: string[] = []) {
    const tidied: [string, string[]][] = [];
    const notices: LaneNotice[] = [];
    let removes: string[] = [];
    let gate: (() => void) | null = null;
    const l = inspectorLane({
      start: () => Promise.resolve({ ok: true as const, job: job('job-1', 'starting') }),
      busy: () => Promise.resolve(false),
      notify: (n) => notices.push(n),
      tidy: async (project, keep) => {
        if (gate === null) {
          await new Promise<void>((r) => {
            gate = r;
          });
        }
        tidied.push([project, [...keep].sort()]);
        return { removed: removes, changed: removes.length > 0 };
      },
      resumable: () => resumable,
    });
    return {
      l,
      tidied,
      notices,
      open: () => {
        gate?.();
        gate = () => undefined;
      },
      removing: (ids: string[]) => {
        removes = ids;
      },
    };
  }

  it('keeps the spaces of chambers whose job can be resumed, and of a drop that holds them', async () => {
    const t = lane(['R']);
    t.open();
    const release = await t.l.hold('E:/p', ['H1', 'H2']);
    await t.l.cancelProject('E:/p');
    release();
    await t.l.cancelProject('E:/p');
    expect(t.tidied).toEqual([
      ['E:/p', ['H1', 'H2', 'R']],
      ['E:/p', ['R']],
    ]);
  });

  it('a drop waits for the start-up tidy; each project once', async () => {
    const t = lane();
    const up = t.l.startUp([
      { pipeline: 'flyability.import', project: 'E:/p' },
      { pipeline: 'pano.stitch', project: 'E:/q' },
      { pipeline: 'flyability.import', project: 'E:/p' },
    ] as JobRecord[]);
    let held = false;
    const hold = t.l.hold('E:/p', ['A']).then(() => {
      held = true;
    });
    await Promise.resolve();
    expect(held).toBe(false);
    t.open();
    await up;
    await hold;
    expect(held).toBe(true);
    expect(t.tidied).toEqual([['E:/p', []]]);
  });

  it('a tidy that changed the manifest tells the window', async () => {
    const t = lane();
    t.open();
    t.removing(['fly-b']);
    await t.l.cancelProject('E:/p');
    expect(t.notices).toEqual([{ project: 'E:/p', state: 'tidied', removed: ['fly-b'] }]);
  });
});
