import {
  emptyRemovalPlan,
  type JobRecord,
  type ProjectManifest,
  type RemovalPlan,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  PACKAGE_REFUSAL,
  emptyTrashAnswer,
  journaledRemovals,
  planJobsFor,
  removalPlanAnswer,
  removeAnswer,
  removeWalkAnswer,
  trashAnswer,
  type RemovalDeps,
  type RemovalLib,
} from './removal';

const ROOT = 'C:/data/projects/site';
const job = (id: string, project: string): JobRecord => ({
  id,
  pipeline: 'photo.align',
  project,
  params: { run: 'r1' },
  status: 'failed',
  progress: 0,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-13T08:00:00.000Z',
  updatedAt: '2026-10-13T08:00:00.000Z',
});
const PLAN: RemovalPlan = {
  ...emptyRemovalPlan(),
  jobs: ['job-1'],
  runs: [{ id: 'r1', status: 'failed', why: 'asked' }],
};
const MANIFEST = {} as ProjectManifest;

function deps(
  lib: Partial<RemovalLib>,
  order: string[] = [],
  o: { pkg?: boolean } = {},
): RemovalDeps {
  return {
    root: (id) => (id === 'p' ? ROOT : undefined),
    isPackage: () => o.pkg === true,
    jobs: () => [job('job-1', ROOT), job('job-other', 'C:/data/projects/other')],
    deleteJob: (id) => {
      order.push(`delete ${id}`);
      return true;
    },
    flushJobs: () => {
      order.push('flush');
      return Promise.resolve();
    },
    log: (line) => {
      order.push(`log ${line}`);
    },
    lib: () => Promise.resolve(lib as RemovalLib),
  };
}

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return {
    wait,
    open: () => {
      open();
    },
  };
}

describe('removal channels', () => {
  it("hands the plan this project's jobs only", async () => {
    let seen: string[] = [];
    const lib: Partial<RemovalLib> = {
      planRemoval: (_root, _t, o) => {
        seen = (o?.jobs ?? []).map((j) => j.id);
        return Promise.resolve(PLAN);
      },
    };
    const r = await removalPlanAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib));
    expect(r).toEqual({ ok: true, plan: PLAN });
    expect(seen).toEqual(['job-1']);
    expect(planJobsFor('c:\\data\\projects\\site', [job('a', ROOT)]).map((j) => j.id)).toEqual(
      process.platform === 'win32' ? ['a'] : [],
    );
  });

  it('deletes job records only after the save, then flushes', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => {
        order.push('save');
        return Promise.resolve({ manifest: MANIFEST, plan: PLAN, trash: 'x' });
      },
    };
    const r = await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib, order));
    expect(r).toEqual({ ok: true, manifest: MANIFEST, plan: PLAN });
    expect(order).toEqual(['save', 'delete job-1', 'flush']);
  });

  it('deletes no job record when the save fails', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => Promise.reject(new Error('manifest.json could not be saved')),
    };
    const r = await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, deps(lib, order));
    expect(r).toEqual({ ok: false, error: 'manifest.json could not be saved' });
    expect(order).toEqual([]);
  });

  it('keeps going when a job record cannot be deleted, and logs it', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => Promise.resolve({ manifest: MANIFEST, plan: PLAN, trash: 'x' }),
    };
    const d = deps(lib, order);
    d.deleteJob = () => {
      throw new Error('index locked');
    };
    expect((await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, d)).ok).toBe(true);
    expect(order.some((l) => l.startsWith('log ') && l.includes('job-1'))).toBe(true);
  });

  it('logs a job record the index would not delete, and a trash it could not read', async () => {
    const order: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeItems: () => Promise.resolve({ manifest: MANIFEST, plan: PLAN, trash: 'x' }),
      trashSize: () => Promise.reject(new Error('access denied')),
    };
    const d = deps(lib, order);
    d.deleteJob = () => false;
    expect((await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, d)).ok).toBe(true);
    expect(order.some((l) => l.startsWith('log ') && l.includes('job-1'))).toBe(true);
    expect(await trashAnswer({ projectId: 'p' }, d)).toEqual({ bytes: 0, entries: 0 });
    expect(order.some((l) => l.startsWith('log ') && l.includes('access denied'))).toBe(true);
  });

  it('refuses a package and a project that is not open', async () => {
    const pkg = deps({}, [], { pkg: true });
    expect(await removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, pkg)).toEqual({
      ok: false,
      error: PACKAGE_REFUSAL,
    });
    const plan = await removalPlanAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, pkg);
    expect(plan.ok && plan.plan.refused).toBe(PACKAGE_REFUSAL);
    expect(await trashAnswer({ projectId: 'p' }, pkg)).toEqual({ bytes: 0, entries: 0 });
    expect(await emptyTrashAnswer({ projectId: 'p' }, pkg)).toEqual({
      ok: false,
      error: PACKAGE_REFUSAL,
    });
    expect(await removeWalkAnswer({ projectId: 'p', layerId: 'walk-w' }, pkg)).toEqual({
      ok: false,
      error: PACKAGE_REFUSAL,
    });
    expect(
      (await removeAnswer({ projectId: 'closed', targets: [{ run: 'r1' }] }, deps({}))).ok,
    ).toBe(false);
  });

  it('sizes and empties the trash', async () => {
    const lib: Partial<RemovalLib> = {
      trashSize: () => Promise.resolve({ bytes: 2048, entries: 2 }),
      emptyTrash: () => Promise.resolve({ freed: 1024, removed: ['a'], held: ['b'] }),
    };
    expect(await trashAnswer({ projectId: 'p' }, deps(lib))).toEqual({ bytes: 2048, entries: 2 });
    expect(await emptyTrashAnswer({ projectId: 'p' }, deps(lib))).toEqual({
      ok: true,
      freed: 1024,
      held: 1,
    });
  });

  it('names the journaled files a removal changed', () => {
    expect(
      journaledRemovals({
        ...emptyRemovalPlan(),
        tilesets: ['t'],
        changes: [{ id: 'chg-1', name: 'x', why: 'asked' }],
        detections: ['detections/pass-1.json'],
      }),
    ).toEqual(['manifest.json', 'tilesets.json', 'change/chg-1.json', 'detections/pass-1.json']);
    expect(journaledRemovals(emptyRemovalPlan())).toEqual(['manifest.json']);
    // a removed run's run.json and gcp.json are journaled; so is a model file a plan moves
    expect(
      journaledRemovals({
        ...emptyRemovalPlan(),
        runs: [{ id: 'r1', status: 'failed', why: 'asked' }],
        files: ['photogrammetry/r1', 'models/m1.procmodel.json', 'models/m1.glb'],
      }),
    ).toEqual([
      'manifest.json',
      'photogrammetry/r1/run.json',
      'photogrammetry/r1/gcp.json',
      'models/m1.procmodel.json',
    ]);
  });
});

describe('one removal at a time per project', () => {
  it('runs two concurrent removes on one project one after the other', async () => {
    const order: string[] = [];
    const first = gate();
    let n = 0;
    const lib: Partial<RemovalLib> = {
      removeItems: async () => {
        const k = String(++n);
        order.push(`start ${k}`);
        if (k === '1') await first.wait;
        order.push(`end ${k}`);
        return { manifest: MANIFEST, plan: emptyRemovalPlan(), trash: null };
      },
    };
    const d = deps(lib);
    const a = removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, d);
    const b = removeAnswer({ projectId: 'p', targets: [{ run: 'r2' }] }, d);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start 1']);
    first.open();
    expect((await a).ok && (await b).ok).toBe(true);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('queues Empty project trash and a walk removal behind a running remove, even a failed one', async () => {
    const order: string[] = [];
    const first = gate();
    const lib: Partial<RemovalLib> = {
      removeItems: async () => {
        order.push('remove');
        await first.wait;
        throw new Error('A file is in use.');
      },
      emptyTrash: () => {
        order.push('empty');
        return Promise.resolve({ freed: 0, removed: [], held: [] });
      },
      removeWalk: () => {
        order.push('walk');
        return Promise.resolve(MANIFEST);
      },
    };
    const d = deps(lib);
    const a = removeAnswer({ projectId: 'p', targets: [{ run: 'r1' }] }, d);
    const b = emptyTrashAnswer({ projectId: 'p' }, d);
    const c = removeWalkAnswer({ projectId: 'p', layerId: 'walk-w' }, d);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['remove']);
    first.open();
    expect(await a).toEqual({ ok: false, error: 'A file is in use.' });
    expect((await b).ok).toBe(true);
    expect(await c).toEqual({ ok: true, manifest: MANIFEST });
    expect(order).toEqual(['remove', 'empty', 'walk']);
  });
});

describe('walks:remove', () => {
  it("hands removeWalk this project's jobs and answers its refusal", async () => {
    let seen: string[] = [];
    const lib: Partial<RemovalLib> = {
      removeWalk: (_root, layerId, _now, o) => {
        seen = (o?.jobs ?? []).map((j) => j.id);
        return Promise.reject(
          new Error(`Processing the walk uses "${layerId}" and is still running. Cancel it first.`),
        );
      },
    };
    const r = await removeWalkAnswer({ projectId: 'p', layerId: 'walk-w' }, deps(lib));
    expect(seen).toEqual(['job-1']);
    expect(r).toEqual({
      ok: false,
      error: 'Processing the walk uses "walk-w" and is still running. Cancel it first.',
    });
    expect((await removeWalkAnswer({ projectId: 'closed', layerId: 'walk-w' }, deps(lib))).ok).toBe(
      false,
    );
  });
});
