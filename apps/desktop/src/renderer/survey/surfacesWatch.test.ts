import type { HeightTiles, JobRecord } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { cloud, dsm, lineUpManifest, ortho } from '../lineup/testing';

vi.mock('../shell', () => ({ bridge: { call: vi.fn() } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const { connectSurfacesWatch, shouldAutoPrepare } = await import('./surfacesWatch');
const { createPreparedSurfaces } = await import('./surfaceStates');

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const three = () =>
  lineUpManifest({
    captures: [
      { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
      { id: 'd2', label: 'Survey 13 April 2026', date: '2026-04-13' },
      { id: 'd3', label: 'Survey 4 May 2026', date: '2026-05-04' },
    ],
    layers: [dsm('dsm1', 'd1'), dsm('dsm2', 'd2'), cloud('pc3', 'd3'), ortho('o3', 'd3')],
  });

const job = (id: string, status: JobRecord['status'], params: object = {}): JobRecord =>
  ({
    id,
    pipeline: 'survey.prepare',
    project: 'C:/p',
    params,
    status,
    progress: 0,
    steps: [],
    artifacts: [],
    createdAt: '',
    updatedAt: '',
  }) as JobRecord;

function setup(
  opts: {
    python?: boolean;
    setting?: boolean;
    writable?: boolean;
    have?: HeightTiles[];
    kitDates?: string[];
  } = {},
) {
  const workspace = createWorkspace();
  const jobs = createStore<{ jobs: JobRecord[] }>()(() => ({ jobs: [] }));
  const prepared = createPreparedSurfaces();
  const flags = { python: opts.python ?? true };
  let n = 0;
  const start = vi.fn((req: { pipeline: string; project: string; params: object }) => {
    n += 1;
    const id = `j${n}`;
    jobs.setState({ jobs: [job(id, 'running', req.params), ...jobs.getState().jobs] });
    return Promise.resolve({ jobId: id });
  });
  const have = { surfaces: opts.have ?? [] };
  const readSurfaces = vi.fn(() => Promise.resolve(have.surfaces));
  const refresh = vi.fn(() => Promise.resolve());
  const ready: (() => void)[] = [];
  const kitSeen: string[][] = [];
  const kitDates = vi.fn(() => Promise.resolve(opts.kitDates ?? []));
  const prepareKit = vi.fn((_id: string, _surfaces: HeightTiles[], dates: readonly string[]) => {
    kitSeen.push([...prepared.getState().kitPreparing]);
    have.surfaces = [
      ...have.surfaces,
      ...dates.map(
        (d) =>
          ({ id: `kit-${d}`, capture: d, source: { kind: 'kit-dsm', epoch: d } }) as HeightTiles,
      ),
    ];
    return Promise.resolve();
  });
  const stop = connectSurfacesWatch({
    workspace,
    jobs,
    prepared,
    setting: () => opts.setting ?? true,
    writable: () => opts.writable ?? true,
    hasPython: () => flags.python,
    onReady: (cb) => {
      ready.push(cb);
      return vi.fn();
    },
    readSurfaces,
    start,
    refresh,
    kitDates,
    prepareKit,
    wait: () => Promise.resolve(),
  });
  const open = (manifest = three()) => {
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
  };
  const end = (id: string, status: JobRecord['status']) => {
    jobs.setState({
      jobs: jobs.getState().jobs.map((j) => (j.id === id ? { ...j, status } : j)),
    });
  };
  return {
    workspace,
    jobs,
    prepared,
    start,
    readSurfaces,
    refresh,
    stop,
    open,
    end,
    have,
    flags,
    ready,
    prepareKit,
    kitSeen,
  };
}

describe('shouldAutoPrepare', () => {
  const yes = { setting: true, writable: true, hasPython: true, cancelled: false, missing: 2 };
  it('starts only when every condition holds', () => {
    expect(shouldAutoPrepare(yes)).toBe(true);
    expect(shouldAutoPrepare({ ...yes, setting: false })).toBe(false);
    expect(shouldAutoPrepare({ ...yes, writable: false })).toBe(false);
    expect(shouldAutoPrepare({ ...yes, hasPython: false })).toBe(false);
    expect(shouldAutoPrepare({ ...yes, cancelled: true })).toBe(false);
    expect(shouldAutoPrepare({ ...yes, missing: 0 })).toBe(false);
  });
});

describe('connectSurfacesWatch', () => {
  it('starts one quiet job on open for every dated survey without a surface', async () => {
    const have = [
      { id: 'dsm1', capture: 'd1', source: { kind: 'dsm', layer: 'dsm1' } },
    ] as unknown as HeightTiles[];
    const w = setup({ have });
    w.open();
    await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    const req = w.start.mock.calls[0]?.[0];
    expect(req?.pipeline).toBe('survey.prepare');
    expect(req?.project).toBe('C:/p');
    expect(req?.params).toEqual({
      surfaces: [
        {
          id: 'dsm2',
          name: 'Survey 13 April 2026 DSM',
          source: { kind: 'dsm', layer: 'dsm2' },
          capture: 'd2',
        },
        {
          id: 'pc3',
          name: 'Survey 4 May 2026 cloud',
          source: { kind: 'cloud', layer: 'pc3' },
          capture: 'd3',
        },
      ],
    });
    // the prepared surfaces are published for the chips
    expect(w.prepared.getState()).toMatchObject({ projectId: 'p', surfaces: have, kitDates: [] });
    // a manifest change while it runs starts nothing more
    w.open(three());
    await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('starts nothing after a cancel until the project is opened again', async () => {
    const w = setup();
    w.open();
    await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    w.end('j1', 'cancelled');
    await flush();
    // a survey date added: still nothing
    w.open(three());
    await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    // closed and opened again
    w.workspace.getState().closeProject();
    await flush();
    w.open();
    await flush();
    expect(w.start).toHaveBeenCalledTimes(2);
    w.stop();
  });

  it('a finished job refreshes both stores and the published surfaces', async () => {
    const w = setup();
    w.open();
    await flush();
    const done = [
      { id: 'dsm1', capture: 'd1', source: { kind: 'dsm', layer: 'dsm1' } },
    ] as unknown as HeightTiles[];
    w.have.surfaces = done;
    w.end('j1', 'done');
    await flush();
    expect(w.refresh).toHaveBeenCalledTimes(1);
    expect(w.prepared.getState().surfaces).toEqual(done);
    // the dates it tried are not tried again on their own
    expect(w.start).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('a prepare job started elsewhere also refreshes, and none starts beside it', async () => {
    const w = setup();
    w.jobs.setState({ jobs: [job('x', 'running')] });
    w.open();
    await flush();
    expect(w.start).not.toHaveBeenCalled();
    w.end('x', 'done');
    await flush();
    expect(w.refresh).toHaveBeenCalledTimes(1);
    // the dates still lack surfaces: now it starts
    expect(w.start).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('waits for the pipeline Python, and starts nothing when the setting is off or read-only', async () => {
    const w = setup({ python: false });
    w.open();
    await flush();
    expect(w.start).not.toHaveBeenCalled();
    w.flags.python = true;
    for (const cb of w.ready) cb();
    await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    w.stop();

    for (const o of [{ setting: false }, { writable: false }]) {
      const x = setup(o);
      x.open();
      await flush();
      expect(x.start).not.toHaveBeenCalled();
      x.stop();
    }
  });

  it('makes the kit DSM surfaces of a kit project without a DSM or cloud layer, with no Python', async () => {
    const kitProject = lineUpManifest({
      captures: [
        { id: 'k1', label: 'Survey 31 December 2020', date: '2020-12-31' },
        { id: 'k2', label: 'Survey 10 January 2021', date: '2021-01-10' },
      ],
      layers: [ortho('o1', 'k1')],
    });
    const w = setup({ python: false, kitDates: ['k1', 'k2'] });
    w.open(kitProject);
    await flush();
    expect(w.prepareKit).toHaveBeenCalledTimes(1);
    expect(w.prepareKit.mock.calls[0]?.[2]).toEqual(['k1', 'k2']);
    // the dates read as preparing while it runs, and are published as kit dates
    expect(w.kitSeen).toEqual([['k1', 'k2']]);
    expect(w.prepared.getState().kitPreparing).toEqual([]);
    expect(w.prepared.getState().kitDates).toEqual(['k1', 'k2']);
    expect(w.refresh).toHaveBeenCalled();
    expect(w.prepared.getState().surfaces.map((s) => s.capture)).toEqual(['k1', 'k2']);
    expect(w.start).not.toHaveBeenCalled();
    w.stop();

    for (const o of [{ setting: false }, { writable: false }]) {
      const x = setup({ ...o, kitDates: ['k1', 'k2'] });
      x.open(kitProject);
      await flush();
      expect(x.prepareKit).not.toHaveBeenCalled();
      expect(x.prepared.getState().kitDates).toEqual(['k1', 'k2']);
      x.stop();
    }
  });
});
