import type { IpcRequest, JobEvent, JobRecord } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { inspectorLane } from './inspectorLane';

type Req = IpcRequest<'jobs:start'>;
const req = (src: string): Req => ({
  pipeline: 'flyability.import',
  project: 'E:/p',
  params: { src, inspections: [{ id: src }] },
});
const job = (id: string, status: JobRecord['status']) =>
  ({ id, pipeline: 'flyability.import', status }) as JobRecord;
const ended = (id: string, status: JobRecord['status'] = 'done'): JobEvent => ({
  type: 'update',
  job: job(id, status),
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
    await t.lane.settled(ended('job-2', 'cancelled'));
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
});
