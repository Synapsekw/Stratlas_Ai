import type { HeightTiles, JobRecord, QaLevel } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { dsm, lineUpManifest } from '../lineup/testing';
import { connectNewDatesWatch, newDateSteps, type NewDatesWatchDeps } from './newDatesWatch';

const flush = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve();
};

const CAPTURES = [
  { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
  { id: 'd2', label: 'Survey 13 April 2026', date: '2026-04-13' },
  { id: 'd3', label: 'Survey 4 May 2026', date: '2026-05-04' },
];

const T0 = '2026-05-05T10:00:00Z';
const LATER = '2026-05-05T11:00:00Z';
const EARLIER = '2026-05-05T09:00:00Z';

const surface = (capture: string, kind = 'dsm', preparedAt = T0): HeightTiles =>
  ({
    id: `${kind}-${capture}`,
    capture,
    preparedAt,
    source: { kind, layer: `${kind}${capture}` },
  }) as unknown as HeightTiles;

const job = (
  id: string,
  pipeline: string,
  status: JobRecord['status'],
  params: object = {},
): JobRecord =>
  ({
    id,
    pipeline,
    project: 'C:/p',
    params,
    status,
    progress: 0,
    steps: [],
    artifacts: [],
    createdAt: '',
    updatedAt: '',
  }) as unknown as JobRecord;

describe('newDateSteps', () => {
  const base = {
    captures: CAPTURES,
    fresh: new Set(['d3']),
    surfaces: [surface('d1'), surface('d2'), surface('d3')],
    checked: [] as { capture: string; checkedAt: string }[],
    pairs: [] as { from: string; to: string; createdAt: string }[],
    tried: new Set<string>(),
    qa: true,
  };

  it('checks a new date against the one before and computes the pair', () => {
    expect(newDateSteps(base)).toEqual([
      {
        kind: 'qa',
        capture: 'd3',
        surface: 'dsm-d3',
        previous: { capture: 'd2', surface: 'dsm-d2' },
      },
      { kind: 'change', from: 'd2', to: 'd3' },
    ]);
  });

  it('never repeats a date checked or a pair computed after its surface was made', () => {
    expect(
      newDateSteps({
        ...base,
        checked: [{ capture: 'd3', checkedAt: LATER }],
        pairs: [{ from: 'd2', to: 'd3', createdAt: LATER }],
      }),
    ).toEqual([]);
    expect(newDateSteps({ ...base, tried: new Set(['qa:d3', 'change:d2>d3']) })).toEqual([]);
  });

  it('checks a date again when its surface was prepared again after the check', () => {
    const steps = newDateSteps({
      ...base,
      checked: [{ capture: 'd3', checkedAt: EARLIER }],
      pairs: [{ from: 'd2', to: 'd3', createdAt: EARLIER }],
    });
    expect(steps.map((s) => s.kind)).toEqual(['qa', 'change']);
  });

  it('does nothing on a project with one date, nor for the earliest date', () => {
    expect(
      newDateSteps({ ...base, captures: CAPTURES.slice(0, 1), fresh: new Set(['d1']) }),
    ).toEqual([]);
    expect(newDateSteps({ ...base, fresh: new Set(['d1']) })).toEqual([]);
  });

  it('checks against the nearest earlier date with a surface, and pairs with the date before', () => {
    // d2 has no surface: the check compares with d1, the change pair stays (d2, d3)
    expect(newDateSteps({ ...base, surfaces: [surface('d1'), surface('d3')] })).toEqual([
      {
        kind: 'qa',
        capture: 'd3',
        surface: 'dsm-d3',
        previous: { capture: 'd1', surface: 'dsm-d1' },
      },
      { kind: 'change', from: 'd2', to: 'd3' },
    ]);
  });

  it('skips the check with no earlier surface or when QA may not run, keeps the compute', () => {
    expect(newDateSteps({ ...base, surfaces: [surface('d3')] })).toEqual([
      { kind: 'change', from: 'd2', to: 'd3' },
    ]);
    expect(newDateSteps({ ...base, qa: false })).toEqual([
      { kind: 'change', from: 'd2', to: 'd3' },
    ]);
  });

  it('waits for the new date surface and goes in date order', () => {
    expect(newDateSteps({ ...base, surfaces: [surface('d1'), surface('d2')] })).toEqual([]);
    const both = newDateSteps({ ...base, fresh: new Set(['d3', 'd2']) });
    expect(both.map((s) => (s.kind === 'qa' ? `qa ${s.capture}` : `${s.from}>${s.to}`))).toEqual([
      'qa d2',
      'd1>d2',
      'qa d3',
      'd2>d3',
    ]);
  });

  it('prefers the DSM over a cloud for the surface', () => {
    const steps = newDateSteps({
      ...base,
      surfaces: [surface('d2'), surface('d3', 'cloud'), surface('d3', 'dsm')],
    });
    expect(steps[0]).toMatchObject({ kind: 'qa', surface: 'dsm-d3' });
  });
});

type Outcome = 'done' | 'failed' | 'cancelled' | null;

function setup(
  opts: {
    setting?: boolean;
    writable?: boolean;
    python?: boolean;
    level?: QaLevel;
    checked?: { capture: string; checkedAt: string }[];
    pairs?: { from: string; to: string; createdAt: string }[];
    busy?: () => boolean;
    change?: () => Promise<Outcome>;
    checkpoints?: { gcp: string } | null;
    wait?: (ms: number) => Promise<void>;
    readSurfaces?: NewDatesWatchDeps['readSurfaces'];
  } = {},
) {
  const workspace = createWorkspace();
  const jobs = createStore<{ jobs: JobRecord[] }>()(() => ({ jobs: [] }));
  const flags = { setting: opts.setting ?? true };
  const data = {
    surfaces: [surface('d1'), surface('d2'), surface('d3')],
    checked: opts.checked ?? [],
    pairs: opts.pairs ?? [],
  };
  let n = 0;
  const startQa = vi.fn((req: { params: { capture: string } }) => {
    n += 1;
    const id = `qa${String(n)}`;
    jobs.setState({ jobs: [job(id, 'survey.qa', 'running', req.params), ...jobs.getState().jobs] });
    return Promise.resolve({ jobId: id });
  });
  const computeChange = vi.fn((_p: string, pair: { from: string; to: string }) => {
    if (opts.change) return opts.change();
    data.pairs = [...data.pairs, { ...pair, createdAt: LATER }];
    return Promise.resolve<Outcome>('done');
  });
  const cancelChange = vi.fn();
  const refresh = vi.fn();
  const stop = connectNewDatesWatch({
    workspace,
    jobs,
    setting: () => flags.setting,
    writable: () => opts.writable ?? true,
    hasPython: () => opts.python ?? true,
    busy: opts.busy ?? (() => false),
    readSurfaces: opts.readSurfaces ?? (() => Promise.resolve(data.surfaces)),
    readChecked: () => Promise.resolve(data.checked),
    readPairs: () => Promise.resolve(data.pairs),
    qaLevel: () => Promise.resolve(opts.level ?? 'moderate'),
    checkpoints: () => Promise.resolve(opts.checkpoints ?? null),
    startQa,
    computeChange,
    cancelChange,
    refresh,
    wait: opts.wait ?? (() => Promise.resolve()),
  });
  const open = (captures = CAPTURES, id = 'p') => {
    workspace.getState().openProject({
      id,
      root: 'C:/p',
      manifest: lineUpManifest({
        captures,
        layers: captures.map((c) => dsm(`dsm${c.id}`, c.id)),
      }),
    });
  };
  /** A prepare job for `captures` that runs and then ends with `status`. */
  const prepared = (captures: string[], status: JobRecord['status'] = 'done') => {
    const id = `prep${String(jobs.getState().jobs.length + 1)}`;
    const params = { surfaces: captures.map((c) => ({ id: `dsm-${c}`, capture: c })) };
    jobs.setState({
      jobs: [job(id, 'survey.prepare', 'running', params), ...jobs.getState().jobs],
    });
    jobs.setState({
      jobs: jobs.getState().jobs.map((j) => (j.id === id ? { ...j, status } : j)),
    });
  };
  const endQa = (status: JobRecord['status']) => {
    jobs.setState({
      jobs: jobs
        .getState()
        .jobs.map((j) =>
          j.pipeline === 'survey.qa' && j.status === 'running' ? { ...j, status } : j,
        ),
    });
  };
  const dropQa = () => {
    jobs.setState({ jobs: jobs.getState().jobs.filter((j) => j.pipeline !== 'survey.qa') });
  };
  return {
    workspace,
    open,
    prepared,
    endQa,
    dropQa,
    startQa,
    computeChange,
    cancelChange,
    refresh,
    stop,
    flags,
    data,
  };
}

describe('connectNewDatesWatch', () => {
  it('runs the QA job then the change compute after a new date is prepared', async () => {
    const w = setup({ level: 'strict', checkpoints: { gcp: 'photogrammetry/r1/gcp.json' } });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa).toHaveBeenCalledTimes(1);
    expect(w.startQa.mock.calls[0]?.[0]).toEqual({
      pipeline: 'survey.qa',
      project: 'C:/p',
      params: {
        capture: 'd3',
        surface: 'dsm-d3',
        level: 'strict',
        checkpoints: { gcp: 'photogrammetry/r1/gcp.json' },
        previous: { capture: 'd2', surface: 'dsm-d2' },
      },
    });
    // one at a time: the compute waits for the QA job
    expect(w.computeChange).not.toHaveBeenCalled();
    w.data.checked = [{ capture: 'd3', checkedAt: LATER }];
    w.endQa('done');
    await flush();
    expect(w.computeChange).toHaveBeenCalledWith('p', { from: 'd2', to: 'd3' });
    expect(w.refresh).toHaveBeenCalled();
    w.stop();
  });

  it('never repeats a date already done', async () => {
    const w = setup({
      checked: [{ capture: 'd3', checkedAt: LATER }],
      pairs: [{ from: 'd2', to: 'd3', createdAt: LATER }],
    });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa).not.toHaveBeenCalled();
    expect(w.computeChange).not.toHaveBeenCalled();
  });

  it('tries each step once per prepare, and again after the date is prepared again', async () => {
    const w = setup({ python: false, change: () => Promise.resolve('failed') });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(1);
    // the same step is not retried by itself
    w.prepared(['d2']);
    await flush();
    expect(w.computeChange.mock.calls.map((c) => c[1])).toEqual([
      { from: 'd2', to: 'd3' },
      { from: 'd1', to: 'd2' },
    ]);
    // d3 prepared again: its step is tried afresh
    w.prepared(['d3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(3);
  });

  it('does nothing on a project with one date', async () => {
    const w = setup();
    w.open(CAPTURES.slice(0, 1));
    w.prepared(['d1']);
    await flush();
    expect(w.startQa).not.toHaveBeenCalled();
    expect(w.computeChange).not.toHaveBeenCalled();
  });

  it('does nothing with the switch off, for a read-only project, or on a failed prepare', async () => {
    const off = setup({ setting: false });
    off.open();
    off.prepared(['d3']);
    await flush();
    expect(off.startQa).not.toHaveBeenCalled();
    expect(off.computeChange).not.toHaveBeenCalled();

    const ro = setup({ writable: false });
    ro.open();
    ro.prepared(['d3']);
    await flush();
    expect(ro.startQa).not.toHaveBeenCalled();

    const failed = setup();
    failed.open();
    failed.prepared(['d3'], 'failed');
    await flush();
    expect(failed.startQa).not.toHaveBeenCalled();
  });

  it('runs the QA at level off as a hand run does (measured, no verdict)', async () => {
    const w = setup({ level: 'off' });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa.mock.calls[0]?.[0].params).toMatchObject({ capture: 'd3', level: 'off' });
    expect(w.startQa.mock.calls[0]?.[0].params).not.toHaveProperty('checkpoints');
  });

  it('skips the QA step without Python, and still computes the pair', async () => {
    const w = setup({ python: false });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa).not.toHaveBeenCalled();
    expect(w.computeChange).toHaveBeenCalledWith('p', { from: 'd2', to: 'd3' });
  });

  it('stops the chain for this open when the person cancels the QA job', async () => {
    const w = setup();
    w.open();
    w.prepared(['d2', 'd3']);
    await flush();
    expect(w.startQa).toHaveBeenCalledTimes(1);
    w.endQa('cancelled');
    await flush();
    expect(w.computeChange).not.toHaveBeenCalled();
    expect(w.startQa).toHaveBeenCalledTimes(1);
  });

  it('stops after a cancelled compute', async () => {
    const w = setup({ python: false, change: () => Promise.resolve('cancelled') });
    w.open();
    w.prepared(['d2', 'd3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(1);
  });

  it('waits while a person runs QA or a compute', async () => {
    let busy = 3;
    const w = setup({ busy: () => busy-- > 0 });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(busy).toBeLessThan(0);
    expect(w.startQa).toHaveBeenCalledTimes(1);
  });

  it('does not count a compute that did not start (a person computing) as tried', async () => {
    const results: Outcome[] = [null, 'done'];
    const w = setup({
      python: false,
      change: () => Promise.resolve(results.length > 0 ? (results.shift() as Outcome) : 'done'),
    });
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(2);
  });

  it('moves on when the QA job drops out of the list', async () => {
    const w = setup();
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa).toHaveBeenCalledTimes(1);
    w.dropQa();
    await flush();
    expect(w.computeChange).toHaveBeenCalledWith('p', { from: 'd2', to: 'd3' });
  });

  it('survives a dependency that throws: the step counts as tried, the next one runs', async () => {
    const w = setup();
    w.startQa.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledWith('p', { from: 'd2', to: 'd3' });
    expect(w.startQa).toHaveBeenCalledTimes(1);
    // a failure before any step does not loop
    const r = setup({ readSurfaces: () => Promise.reject(new Error('disk')) });
    r.open();
    r.prepared(['d3']);
    await flush();
    expect(r.startQa).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gives up when the project is closed or switched mid-chain', async () => {
    const w = setup();
    w.open();
    w.prepared(['d3']);
    await flush();
    expect(w.startQa).toHaveBeenCalledTimes(1);
    w.open(CAPTURES, 'other');
    await flush();
    w.endQa('done');
    await flush();
    expect(w.computeChange).not.toHaveBeenCalled();
    expect(w.refresh).not.toHaveBeenCalled();
  });

  it('stops during the settle wait without starting anything', async () => {
    let release: () => void = () => undefined;
    const w = setup({
      wait: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    });
    w.open();
    w.prepared(['d3']);
    await flush();
    w.stop();
    release();
    await flush();
    expect(w.startQa).not.toHaveBeenCalled();
  });

  it('stops during a step: the wait ends and the compute in flight is cancelled', async () => {
    let finish: (o: Outcome) => void = () => undefined;
    const w = setup({
      python: false,
      change: () =>
        new Promise<Outcome>((r) => {
          finish = r;
        }),
    });
    w.open();
    w.prepared(['d2', 'd3']);
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(1);
    w.stop();
    expect(w.cancelChange).toHaveBeenCalledWith({ from: 'd1', to: 'd2' });
    finish('cancelled');
    await flush();
    expect(w.computeChange).toHaveBeenCalledTimes(1);

    const q = setup();
    q.open();
    q.prepared(['d3']);
    await flush();
    q.stop();
    await flush();
    q.endQa('done');
    await flush();
    expect(q.computeChange).not.toHaveBeenCalled();
  });
});
