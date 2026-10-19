import { changeStore, type ChangePairContext } from '@aio/change';
import type { ChangeSet, JobRecord, Layer, ProjectManifest } from '@aio/schema';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ProducerDeps } from '../producers/raster';
import { changesTab } from '../useChangeOverlays';
import { recordVolumesOutcome, releaseFailedArea, runAreaCompare } from './run';

// the tab hook module reaches the whole renderer; only its "show the Changes tab" signal is used
vi.mock('../useChangeOverlays', async () => {
  const { createStore } = await import('zustand/vanilla');
  const changesTab = createStore<{ seq: number }>(() => ({ seq: 0 }));
  return {
    changesTab,
    openChangesTab: () => {
      changesTab.setState((s) => ({ seq: s.seq + 1 }));
    },
  };
});

const raster = (id: string, role: 'ortho' | 'dsm', format = 'cog'): Layer =>
  ({
    kind: 'raster',
    id,
    name: id,
    visible: true,
    role,
    format,
    src: { path: `${id}.json` },
  }) as Layer;

const ctx = (from: Layer[], to: Layer[]): ChangePairContext => ({
  projectId: 'p',
  manifest: {} as ProjectManifest,
  from: 'c1',
  to: 'c2',
  layersFrom: from,
  layersTo: to,
});
const both = ctx(
  [raster('o1', 'ortho'), raster('d1', 'dsm')],
  [raster('o2', 'ortho'), raster('d2', 'dsm')],
);

const AREA = {
  scope: { id: 'm-pad-a', name: 'Pad A' },
  ring: [
    [151.2, -33.8],
    [151.201, -33.8],
    [151.201, -33.801],
  ] as [number, number][],
};
const PAIR = { from: 'c1', to: 'c2' };

const job = (id: string, over: Partial<JobRecord> = {}): JobRecord =>
  ({ id, pipeline: 'change.raster', status: 'done', ...over }) as JobRecord;

type Start = ProducerDeps['start'];
let start: Mock<Start>;

function deps(over: Partial<ProducerDeps> = {}): ProducerDeps {
  let n = 0;
  start = vi.fn<Start>(() => Promise.resolve({ jobId: `job-${String(++n)}` }));
  return {
    root: () => 'C:/projects/site',
    thresholds: () => undefined,
    start,
    projectId: () => 'p',
    ...over,
  };
}

const areaSet = (over: Partial<ChangeSet> = {}): ChangeSet => ({
  schema: 'aio.change/1',
  id: 'c1-c2-change.raster-area-m-pad-a',
  from: 'c1',
  to: 'c2',
  producer: 'change.raster',
  createdAt: '2026-10-19T00:00:00.000Z',
  items: [],
  layers: [],
  stats: {},
  scope: AREA.scope,
  ...over,
});

let save: Mock<(set: ChangeSet) => Promise<boolean>>;
let load: Mock<(projectId: string | null) => Promise<void>>;

beforeEach(() => {
  save = vi.fn(() => Promise.resolve(true));
  load = vi.fn(() => Promise.resolve());
  changeStore.setState({
    projectId: 'p',
    pair: null,
    area: null,
    sets: {
      whole: areaSet({ id: 'c1-c2-change.raster', scope: undefined }),
      other: areaSet({ id: 'c1-c2-change.raster-area-m-b', scope: { id: 'm-b', name: 'B' } }),
      [areaSet().id]: areaSet(),
    },
    save,
    load,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('comparing one area with the previous survey', () => {
  it('starts imagery change only when volumes are off', async () => {
    const d = deps();
    const seq = changesTab.getState().seq;
    expect(await runAreaCompare(d, both, AREA, { volumes: false })).toEqual({
      ok: true,
      notes: [],
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      'change.raster',
      'C:/projects/site',
      expect.objectContaining({ scope: AREA.scope, mask: AREA.ring }),
    );
    expect(changeStore.getState().pair).toEqual(PAIR);
    expect(changeStore.getState().area).toBe('m-pad-a');
    expect(changesTab.getState().seq).toBe(seq + 1);
  });

  it('starts imagery then volumes for the same area', async () => {
    const d = deps();
    expect(await runAreaCompare(d, both, AREA, { volumes: true })).toEqual({ ok: true, notes: [] });
    expect(start.mock.calls.map((c) => c[0])).toEqual(['change.raster', 'change.surface']);
    for (const c of start.mock.calls)
      expect((c[2] as { scope: { id: string } }).scope.id).toBe('m-pad-a');
  });

  it('keeps the imagery run when volumes cannot start, with a note', async () => {
    const d = deps();
    start.mockImplementation((pipeline) =>
      Promise.resolve(pipeline === 'change.surface' ? { error: 'No pack.' } : { jobId: 'job-1' }),
    );
    const r = await runAreaCompare(d, both, AREA, { volumes: true });
    expect(r).toEqual({ ok: true, notes: ['Volumes were not started: No pack.'] });
    expect(changeStore.getState().area).toBe('m-pad-a');

    const noDsm = ctx([raster('o1', 'ortho')], [raster('o2', 'ortho')]);
    const r2 = await runAreaCompare(deps(), noDsm, AREA, { volumes: true });
    expect(r2.ok && r2.notes).toEqual([expect.stringMatching(/^Volumes were not started: .*DSM/)]);
  });

  it('starts nothing else and leaves the panel alone when imagery fails', async () => {
    const d = deps();
    start.mockResolvedValue({ error: 'No pack.' });
    const seq = changesTab.getState().seq;
    expect(await runAreaCompare(d, both, AREA, { volumes: true })).toEqual({
      ok: false,
      error: 'No pack.',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(changeStore.getState().pair).toBeNull();
    expect(changeStore.getState().area).toBeNull();
    expect(changesTab.getState().seq).toBe(seq);
    const none = await runAreaCompare(deps(), ctx([], []), AREA, { volumes: false });
    expect(none.ok ? '' : none.error).toMatch(/ortho on each date/);
  });

  it('records the volumes outcome after the run when volumes were asked for', async () => {
    const finished = vi.fn((id: string) =>
      Promise.resolve(
        id === 'job-2'
          ? job(id, { pipeline: 'change.surface', status: 'failed', error: 'Out of memory.' })
          : job(id),
      ),
    );
    await runAreaCompare(deps({ finished }), both, AREA, { volumes: true });
    await flush();
    await flush();
    expect(save.mock.calls[0]?.[0].volumesMissing?.reason).toBe('Out of memory.');
  });
});

describe('the volumes outcome', () => {
  const finishedWith = (surface: JobRecord | null, imagery: JobRecord | null = job('r')) =>
    vi.fn((id: string) => Promise.resolve(id === 'r' ? imagery : surface));

  it("records why volumes are missing on the area's imagery set", async () => {
    const d = deps({
      finished: finishedWith(
        job('s', { pipeline: 'change.surface', status: 'failed', error: 'No elevation.' }),
      ),
    });
    await recordVolumesOutcome(d, 'r', { jobId: 's' }, AREA.scope, PAIR);
    expect(load).toHaveBeenCalledWith('p');
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.id).toBe('c1-c2-change.raster-area-m-pad-a');
    expect(saved?.volumesMissing?.reason).toBe('No elevation.');
    expect(Number.isNaN(Date.parse(saved?.volumesMissing?.at ?? ''))).toBe(false);
  });

  it('records a misaligned refusal by its gap', async () => {
    const d = deps({
      finished: finishedWith(
        job('s', {
          pipeline: 'change.surface',
          status: 'failed',
          error: 'The dates are 2.01 m apart.',
          failure: { code: 'misaligned', data: { from: 'c1', to: 'c2', shiftM: 2.01 } },
        }),
      ),
    });
    await recordVolumesOutcome(d, 'r', { jobId: 's' }, AREA.scope, PAIR);
    expect(save.mock.calls[0]?.[0].volumesMissing?.reason).toBe('Misaligned by 2.0 m');
  });

  it('records a refused volume start', async () => {
    const d = deps({ finished: finishedWith(null) });
    await recordVolumesOutcome(d, 'r', { error: 'No pack.' }, AREA.scope, PAIR);
    expect(save.mock.calls[0]?.[0].volumesMissing?.reason).toBe('No pack.');
  });

  it('records nothing when volumes ran or were not asked for', async () => {
    const d = deps({ finished: finishedWith(job('s', { pipeline: 'change.surface' })) });
    await recordVolumesOutcome(d, 'r', { jobId: 's' }, AREA.scope, PAIR);
    expect(save).not.toHaveBeenCalled();

    const finished = vi.fn(() => Promise.resolve(job('x')));
    await runAreaCompare(deps({ finished }), both, AREA, { volumes: false });
    await flush();
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('records nothing when imagery failed', async () => {
    const d = deps({
      finished: finishedWith(null, job('r', { status: 'failed', error: 'Boom.' })),
    });
    await recordVolumesOutcome(d, 'r', { error: 'No pack.' }, AREA.scope, PAIR);
    expect(save).not.toHaveBeenCalled();
  });

  it('records nothing after the project changed', async () => {
    let project = 'p';
    const d = deps({
      projectId: () => project,
      finished: vi.fn((id: string) => {
        project = 'q';
        return Promise.resolve(id === 'r' ? job('r') : null);
      }),
    });
    await recordVolumesOutcome(d, 'r', { error: 'No pack.' }, AREA.scope, PAIR);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('an area whose first imagery run does not finish', () => {
  // a first run: the area has no sets yet
  const chosen = () => {
    changeStore.setState({ pair: PAIR, area: 'm-pad-a', sets: {} });
  };
  const ended = (over: Partial<JobRecord>) => vi.fn(() => Promise.resolve(job('r', over)));

  it('falls back to the whole map when imagery failed', async () => {
    chosen();
    await releaseFailedArea(deps({ finished: ended({ status: 'failed' }) }), 'r', 'm-pad-a', PAIR);
    expect(changeStore.getState().area).toBeNull();
  });

  it('does so after a run started from the dialog', async () => {
    const finished = vi.fn((id: string) =>
      Promise.resolve(job(id, { status: id === 'job-1' ? 'cancelled' : 'done' })),
    );
    changeStore.setState({ sets: {} });
    await runAreaCompare(deps({ finished }), both, AREA, { volumes: false });
    await flush();
    await flush();
    expect(changeStore.getState().area).toBeNull();
  });

  it('keeps the area when imagery finished, or was refused for the gap (Line up offer)', async () => {
    chosen();
    await releaseFailedArea(deps({ finished: ended({}) }), 'r', 'm-pad-a', PAIR);
    expect(changeStore.getState().area).toBe('m-pad-a');
    const refused = ended({
      status: 'failed',
      failure: { code: 'misaligned', data: { from: 'c1', to: 'c2', shiftM: 2 } },
    });
    await releaseFailedArea(deps({ finished: refused }), 'r', 'm-pad-a', PAIR);
    expect(changeStore.getState().area).toBe('m-pad-a');
  });

  it('leaves another chosen area, pair or project alone', async () => {
    const failed = ended({ status: 'failed' });
    changeStore.setState({ pair: PAIR, area: 'm-b', sets: {} });
    await releaseFailedArea(deps({ finished: failed }), 'r', 'm-pad-a', PAIR);
    expect(changeStore.getState().area).toBe('m-b');
    changeStore.setState({ pair: { from: 'c0', to: 'c2' }, area: 'm-pad-a' });
    await releaseFailedArea(deps({ finished: failed }), 'r', 'm-pad-a', PAIR);
    expect(changeStore.getState().area).toBe('m-pad-a');
    chosen();
    let project = 'p';
    const moved = vi.fn(() => {
      project = 'q';
      return Promise.resolve(job('r', { status: 'failed' }));
    });
    await releaseFailedArea(
      deps({ finished: moved, projectId: () => project }),
      'r',
      'm-pad-a',
      PAIR,
    );
    expect(changeStore.getState().area).toBe('m-pad-a');
  });

  it('keeps an area that has sets from an earlier run', async () => {
    changeStore.setState({ pair: PAIR, area: 'm-pad-a' });
    await releaseFailedArea(
      deps({ finished: vi.fn(() => Promise.resolve(job('r', { status: 'failed' }))) }),
      'r',
      'm-pad-a',
      PAIR,
    );
    expect(changeStore.getState().area).toBe('m-pad-a');
  });
});
