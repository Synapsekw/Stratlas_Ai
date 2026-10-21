import type {
  ComparisonResult,
  HeightTiles,
  MeasurementsFile,
  SurveyMeasurement,
} from '@aio/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn((channel: string) =>
  Promise.resolve(
    channel === 'survey:writeMeasurements'
      ? { ok: true, value: { ok: true } }
      : { ok: false, error: 'not in this test' },
  ),
);
vi.mock('../shell', () => ({ bridge: { call } }));
vi.mock('../author', () => ({ authorName: () => '' }));

const {
  compareStore,
  carriedIds,
  compute,
  computeAll,
  computeSeries,
  computeSpread,
  engineClient,
  followMeasurements,
  hasCarried,
  isStale,
  keepsCarried,
  recomputeCarried,
  recomputeStandard,
  scheduleCheck,
  seriesStale,
  setEnginePort,
  spreadItem,
  setEngineStarter,
} = await import('./compareStore');
const { isDirty, measureStore, patchMeasurement, revertMeasurements, saveMeasurements } =
  await import('./measureStore');
const { serveEngine } = await import('./engineServe');
const { RunCancelled } = await import('./engineClient');

const DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'schema',
  'src',
  '__fixtures__',
  'survey',
);
const cone = JSON.parse(
  readFileSync(join(DIR, 'tiles', 'cone', 'tiles.json'), 'utf8'),
) as HeightTiles;

const ring = Array.from({ length: 24 }, (_, k): [number, number, number] => [
  302010 + 8 * Math.cos((2 * Math.PI * k) / 24),
  2574010 + 8 * Math.sin((2 * Math.PI * k) / 24),
  0,
]);
const UPDATED = '2026-10-01T00:00:00.000Z';
const pit: SurveyMeasurement = {
  id: 'm1',
  family: 'polygon',
  tool: 'volume',
  label: 'Pit',
  scope: { kind: 'site' },
  points: ring,
  items: [
    {
      id: 'a',
      from: { kind: 'reference', mode: 'level', levelM: 100 },
      to: { kind: 'current' },
      useDeadband: false,
    },
  ],
  results: [],
  createdAt: UPDATED,
  updatedAt: UPDATED,
};

let ports: MessageChannel | null = null;

beforeEach(() => {
  call.mockClear();
  ports = new MessageChannel();
  serveEngine(ports.port2, (url) => {
    const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
    return Promise.resolve(
      m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null,
    );
  });
  setEnginePort(ports.port1);
  engineClient().setContext({
    base: 'aio://project/p1/',
    surfaces: [{ ...cone, capture: 'c2' }],
    captures: ['c1', 'c2'],
    designs: [],
    site: { verticalDatum: { kind: 'project' } },
  });
  compareStore.setState({ projectId: 'p1', status: 'ready', current: {}, computed: {} });
  const file: MeasurementsFile = { schema: 'aio.measurements/1', measurements: [pit] };
  measureStore.setState({
    projectId: 'p1',
    status: 'ready',
    readOnly: false,
    file,
    savedText: JSON.stringify(file),
    resultsUnwritten: false,
    // autosave on: a derived result must still not write the file
    autosave: true,
    message: null,
  });
});

afterEach(() => {
  setEnginePort(null);
  ports?.port1.close();
  ports?.port2.close();
  ports = null;
});

const stored = () => measureStore.getState().file.measurements.find((m) => m.id === 'm1');
const writes = () => call.mock.calls.filter(([c]) => c === 'survey:writeMeasurements').length;

describe('results the app computes on its own', () => {
  it('are shown and kept for the next save, but are not a person edit', async () => {
    const r = await compute('m1', { auto: true });
    expect(r?.results[0]?.status).toBe('ok');
    const m = stored();
    expect(m?.results).toHaveLength(1);
    expect(m?.results[0]?.fingerprint).toBe(r?.results[0]?.fingerprint);
    expect(m?.updatedAt).toBe(UPDATED);
    const s = measureStore.getState();
    expect(isDirty(s)).toBe(false);
    expect(s.resultsUnwritten).toBe(true);
    expect(writes()).toBe(0);
    // the current fingerprint matches: not stale
    expect(compareStore.getState().current.m1).toEqual([r?.results[0]?.fingerprint]);

    // the next save writes them
    expect(await saveMeasurements()).toBe(true);
    expect(writes()).toBe(1);
    expect(measureStore.getState().resultsUnwritten).toBe(false);
  });

  it('leave a person edit unsaved, and revert keeps the derived results', async () => {
    measureStore.setState({ autosave: false });
    patchMeasurement('m1', { label: 'Pit north' });
    expect(isDirty(measureStore.getState())).toBe(true);
    await compute('m1', { auto: true });
    expect(isDirty(measureStore.getState())).toBe(true);
    expect(writes()).toBe(0);
    revertMeasurements();
    expect(stored()?.label).toBe('Pit');
    expect(stored()?.results).toHaveLength(1);
    expect(isDirty(measureStore.getState())).toBe(false);
  });

  it('computeAll passes auto on: the results are no person edit', async () => {
    await computeAll(['m1'], { auto: true });
    expect(stored()?.results).toHaveLength(1);
    expect(stored()?.updatedAt).toBe(UPDATED);
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(writes()).toBe(0);
  });

  it('a person Recompute is an edit (autosave writes it)', async () => {
    await compute('m1');
    expect(stored()?.results).toHaveLength(1);
    expect(stored()?.updatedAt).not.toBe(UPDATED);
    expect(writes()).toBe(1);
  });
});

describe('a run the measurement outgrew', () => {
  it('stores nothing when an item changed while it ran: the change is computed next', async () => {
    const running = compute('m1', { auto: true });
    // the person sets another level while the first run is still out (the Set of the base editor)
    const file = measureStore.getState().file;
    measureStore.setState({
      file: {
        ...file,
        measurements: file.measurements.map((m) =>
          m.id === 'm1'
            ? {
                ...m,
                items: m.items.map((it) => ({
                  ...it,
                  from: { kind: 'reference' as const, mode: 'level' as const, levelM: 90 },
                })),
              }
            : m,
        ),
      },
    });
    const r = await running;
    expect(r?.results[0]?.status).toBe('ok');
    // the answer was for level 100: not stored for level 90, and not taken as current
    expect(stored()?.results).toEqual([]);
    expect(compareStore.getState().current.m1).toBeUndefined();
    expect(compareStore.getState().running.m1).toBe(false);
    // the next run is for level 90
    const next = await compute('m1', { auto: true });
    expect(stored()?.results[0]?.fingerprint).toBe(next?.results[0]?.fingerprint);
    expect(next?.results[0]?.fingerprint).not.toBe(r?.results[0]?.fingerprint);
  });
});

describe('the check after a change', () => {
  it('lets a run in flight finish instead of replacing it: a person Recompute stays an edit', async () => {
    // an engine that reads its tiles only when let: the run is still out when the check fires
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setEnginePort(null);
    ports?.port1.close();
    ports?.port2.close();
    ports = new MessageChannel();
    serveEngine(ports.port2, async (url) => {
      await gate;
      const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
      return m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null;
    });
    setEnginePort(ports.port1);
    engineClient().setContext({
      base: 'aio://project/p1/',
      surfaces: [{ ...cone, capture: 'c2' }],
      captures: ['c1', 'c2'],
      designs: [],
      site: { verticalDatum: { kind: 'project' } },
    });
    measureStore.setState({ focus: 'm1' });

    // a person's Recompute, then the check a change schedules, while the run is still out
    const person = compute('m1');
    scheduleCheck(0);
    const early = await Promise.race([
      person,
      new Promise<'still out'>((resolve) => {
        setTimeout(() => {
          resolve('still out');
        }, 150);
      }),
    ]);
    // the check did not start a run of its own over the person's (that cancelled it: null)
    expect(early).toBe('still out');
    release();
    const r = await person;
    expect(r?.results[0]?.status).toBe('ok');
    // stored as the person's edit, once
    expect(stored()?.results).toHaveLength(1);
    expect(stored()?.updatedAt).not.toBe(UPDATED);
    await vi.waitFor(() => {
      expect(compareStore.getState().running.m1).toBe(false);
    });
    expect(writes()).toBe(1);
  });

  it('is no longer running when the engine stops under a run', async () => {
    // an engine that never reads its tiles: the run is out when the engine is put away
    setEnginePort(null);
    ports?.port1.close();
    ports?.port2.close();
    ports = new MessageChannel();
    serveEngine(ports.port2, () => new Promise<Uint8Array | null>(() => undefined));
    setEnginePort(ports.port1);
    engineClient().setContext({
      base: 'aio://project/p1/',
      surfaces: [{ ...cone, capture: 'c2' }],
      captures: ['c1', 'c2'],
      designs: [],
      site: { verticalDatum: { kind: 'project' } },
    });
    const run = compute('m1');
    expect(compareStore.getState().running.m1).toBe(true);
    setEnginePort(null);
    expect(await run).toBeNull();
    // cancelled, and nothing took its place: Recompute is offered again
    expect(compareStore.getState().running.m1).toBe(false);
  });

  it('stays running when a newer run of the same measurement replaced it', async () => {
    const first = compute('m1', { auto: true });
    const second = compute('m1');
    expect(await first).toBeNull();
    // the first answer (cancelled) must not say the measurement is done
    expect(compareStore.getState().running.m1).toBe(true);
    expect((await second)?.results[0]?.status).toBe('ok');
    expect(compareStore.getState().running.m1).toBe(false);
  });
});

describe('an engine that dies', () => {
  afterEach(() => {
    setEngineStarter(null);
  });

  it('fails the run with what happened, and the next Recompute starts a new engine with the same project', async () => {
    // every engine started here; the first never reads its tiles, so its run is out when it dies
    const started: MessageChannel[] = [];
    setEngineStarter(() => {
      const ch = new MessageChannel();
      const first = started.length === 0;
      started.push(ch);
      serveEngine(ch.port2, (url) => {
        if (first) return new Promise<Uint8Array | null>(() => undefined);
        const m = /survey\/surfaces\/cone\/(.+)$/.exec(url);
        return Promise.resolve(
          m?.[1] ? new Uint8Array(readFileSync(join(DIR, 'tiles', 'cone', m[1]))) : null,
        );
      });
      return ch.port1;
    });
    engineClient().setContext({
      base: 'aio://project/p1/',
      surfaces: [{ ...cone, capture: 'c2' }],
      captures: ['c1', 'c2'],
      designs: [],
      site: { verticalDatum: { kind: 'project' } },
    });
    expect(started).toHaveLength(1);

    const run = compute('m1');
    expect(compareStore.getState().running.m1).toBe(true);
    // the worker reports an uncaught error (as the browser does on its Worker object)
    const dying = started[0]?.port1 as unknown as { onerror?: (ev: { message?: string }) => void };
    dying.onerror?.({ message: 'Uncaught RangeError: Array buffer allocation failed' });
    expect(await run).toBeNull();
    const s = compareStore.getState();
    expect(s.running.m1).toBe(false);
    expect(s.problems.m1).toMatch(/comparison engine stopped/);
    expect(s.problems.m1).toMatch(/Recompute/);
    expect(stored()?.results).toEqual([]);

    // Recompute: a new engine, told the project again, computes
    const again = await compute('m1');
    expect(started).toHaveLength(2);
    expect(again?.results[0]?.status).toBe('ok');
    expect(compareStore.getState().problems.m1).toBeUndefined();
    expect(stored()?.results).toHaveLength(1);
    for (const ch of started) {
      ch.port1.close();
      ch.port2.close();
    }
  });
});

describe('a live run while editing a lined-up date', () => {
  it('receives the stored-frame ring, as the saved runs do', async () => {
    const manifest: ProjectManifest = {
      schema: 'aio.project/1',
      id: 'p1',
      name: 'P',
      crs: { epsg: 32640 },
      origin: [0, 0, 0],
      captures: [
        { id: 'c1', label: 'One', date: '2026-01-01' },
        {
          id: 'c2',
          label: 'Two',
          date: '2026-02-01',
          lineUp: { eastM: 2, northM: -1, with: 'c1', at: '2026-10-16T08:00:00Z' },
        },
      ],
      layers: [],
      severityModels: [],
      classCatalogues: [],
    };
    workspace.getState().openProject({ id: 'p1', root: 'E:/t', manifest });
    const file: MeasurementsFile = {
      schema: 'aio.measurements/1',
      measurements: [{ ...pit, scope: { kind: 'survey', capture: 'c2' } }],
    };
    measureStore.setState({ file, savedText: JSON.stringify(file), autosave: false });
    const off = followMeasurements();
    // the vertices as drawn: the date's shift (2 m east, 1 m south) added
    const drawn = ring.map(([e, n, z]): [number, number, number] => [e + 2, n - 1, z]);
    measureStore.setState({
      focus: 'm1',
      editing: { points: drawn, dragging: null, selected: null } as never,
    });
    // the live run goes through the debounced engine: give it more than the default 1 s, which a
    // full parallel `pnpm check` can use up
    await vi.waitFor(
      () => {
        expect(compareStore.getState().computed.m1?.live).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(compareStore.getState().computed.m1?.ringKey).toContain('302018');
    expect(compareStore.getState().computed.m1?.ringKey).not.toContain('302020');
    off();
  });
});

/** The value, which the test has made sure is there. */
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing');
  return v;
}

describe('results over time and the spread across bases', () => {
  const caps = [
    { id: 'c1', label: 'One', date: '2026-01-01' },
    { id: 'c2', label: 'Two', date: '2026-02-01' },
  ];
  /** Put a measurement in the file as it is now, with some fields changed. */
  const put = (patch: Partial<SurveyMeasurement>) => {
    const file = measureStore.getState().file;
    measureStore.setState({
      file: {
        ...file,
        measurements: file.measurements.map((m) => (m.id === 'm1' ? { ...m, ...patch } : m)),
      },
    });
  };
  const kit = (r: ComparisonResult, epoch: string): ComparisonResult => ({
    ...r,
    netM3: 60,
    totalM3: 64,
    fingerprint: `kit:P01:${epoch}:plane`,
    carried: { from: 'kit', base: 'plane', pile: 'P01', epoch },
  });

  beforeEach(() => {
    compareStore.setState({ captures: caps });
  });

  it('computeSeries computes only missing and stale dates', async () => {
    const spy = vi.spyOn(engineClient(), 'series');
    expect(await computeSeries('m1')).toBe(true);
    expect(stored()?.series?.map((r) => r.toCapture)).toEqual(['c1', 'c2']);
    expect(spy).toHaveBeenCalledTimes(1);
    // derived numbers, not a person's edit
    expect(isDirty(measureStore.getState())).toBe(false);
    expect(stored()?.updatedAt).toBe(UPDATED);
    expect(stored()?.series?.some((r) => seriesStale(must(stored()), r))).toBe(false);

    // nothing missing or stale: nothing run, nothing stored
    expect(await computeSeries('m1')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    // c1's row was computed from other inputs: only c1 is run again
    put({
      series: stored()?.series?.map((r) =>
        r.toCapture === 'c1' ? { ...r, fingerprint: 'old' } : r,
      ),
    });
    const row = must(stored()?.series?.[0]);
    expect(seriesStale(must(stored()), row)).toBe(true);
    await computeSeries('m1');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0].captures).toEqual(['c1']);
    expect(stored()?.series?.map((r) => r.fingerprint)).not.toContain('old');

    // a date asked for on its own: only that one, when it is missing
    put({ series: [] });
    await computeSeries('m1', { captures: ['c2'] });
    expect(spy.mock.calls[2]?.[0].captures).toEqual(['c2']);
    expect(stored()?.series?.map((r) => r.toCapture)).toEqual(['c2']);
    spy.mockRestore();
  });

  it('a carried result is not stale', async () => {
    await computeSeries('m1');
    const m = must(stored());
    const [first, second] = m.series ?? [];
    const carried = kit(must(first), 'e1');
    expect(seriesStale(m, carried)).toBe(false);
    // the result on the card: a fingerprint that is not the current one, still not stale
    compareStore.setState({ current: { m1: ['something else'] } });
    expect(isStale(compareStore.getState(), m, carried)).toBe(false);
    expect(isStale(compareStore.getState(), m, must(first))).toBe(true);

    // a carried date is kept, not run again
    put({ series: [carried, must(second)] });
    const spy = vi.spyOn(engineClient(), 'series');
    await computeSeries('m1');
    expect(spy).not.toHaveBeenCalled();
    expect(stored()?.series?.[0]?.carried?.base).toBe('plane');
    spy.mockRestore();
  });

  it('the check after a change does not replace a carried figure on its own', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [kit(must(r?.results[0]), 'e2')] });
    compareStore.setState({ computed: {}, current: {} });
    measureStore.setState({ focus: 'm1' });
    scheduleCheck(0);
    // the check has run: fingerprints taken, the polygon computed (for its heat map only)
    await vi.waitFor(() => {
      const s = compareStore.getState();
      expect(s.current.m1).toHaveLength(1);
      expect(s.computed.m1).toBeDefined();
      expect(s.running.m1).toBe(false);
    });
    // the run was for the heat map only: what is shown is the stored kit figure, not the engine's
    const shown = compareStore.getState().computed.m1;
    expect(shown?.heatOnly).toBe(true);
    expect(shown?.heat.length).toBeGreaterThan(0);
    expect(shown?.results).toHaveLength(1);
    expect(shown?.results[0]?.carried?.epoch).toBe('e2');
    expect(shown?.results[0]?.netM3).toBe(60);
    expect(stored()?.results[0]?.carried?.epoch).toBe('e2');
    measureStore.setState({ focus: null });
  });

  it('a carried pile absent on the latest date gets no engine figure from the check', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [], series: [kit({ ...must(r?.results[0]), toCapture: 'c1' }, 'e1')] });
    compareStore.setState({ computed: {}, current: {} });
    measureStore.setState({ focus: 'm1' });
    scheduleCheck(0);
    await vi.waitFor(() => {
      const s = compareStore.getState();
      expect(s.current.m1).toHaveLength(1);
      expect(s.computed.m1).toBeDefined();
      expect(s.running.m1).toBe(false);
    });
    expect(compareStore.getState().computed.m1?.results).toEqual([]);
    expect(stored()?.results).toEqual([]);
    measureStore.setState({ focus: null });
  });

  it('series rows are stale after a vertex is edited, until computed again', async () => {
    await computeSeries('m1');
    const row = must(stored()?.series?.[1]);
    expect(seriesStale(must(stored()), row)).toBe(false);
    put({ points: ring.map(([e, n, z], k) => (k === 0 ? [e + 1, n, z] : [e, n, z])) });
    expect(seriesStale(must(stored()), row)).toBe(true);
    expect(await computeSeries('m1')).toBe(true);
    expect(stored()?.series?.some((x) => seriesStale(must(stored()), x))).toBe(false);
  });

  it('no mixed series: an item with carried figures is not computed over time', async () => {
    const r = await compute('m1', { live: true });
    const fresh = must(r?.results[0]);
    const spy = vi.spyOn(engineClient(), 'series');
    // a carried figure on the latest date
    put({ results: [kit(fresh, 'e2')] });
    expect(await computeSeries('m1')).toBe(false);
    expect(stored()?.series).toBeUndefined();
    // only carried figures over time (absent on the latest date)
    put({ results: [], series: [kit({ ...fresh, toCapture: 'c1' }, 'e1')] });
    expect(await computeSeries('m1')).toBe(false);
    expect(stored()?.series).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('recomputeStandard accepts a pile absent on the latest date and keeps was', async () => {
    const r = await compute('m1', { live: true });
    const fresh = must(r?.results[0]);
    put({
      results: [],
      series: [
        kit({ ...fresh, toCapture: 'c1' }, 'e1'),
        { ...kit({ ...fresh, toCapture: 'c2' }, 'e2'), netM3: 70, totalM3: 72 },
      ],
    });
    expect(await recomputeStandard('m1')).toBeNull();
    const m = stored();
    expect(m?.results).toHaveLength(1);
    expect(m?.results[0]?.carried).toBeUndefined();
    expect(m?.series).toBeUndefined();
    // the latest carried figure is the "was"
    expect(m?.previousResults).toEqual([
      expect.objectContaining({ netM3: 70, totalM3: 72, label: 'kit, Best-fit plane' }),
    ]);
  });

  it('editing a carried pile accepts the standard base: the next check replaces it, keeping was', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [kit(must(r?.results[0]), 'e2')] });
    const off = followMeasurements();
    try {
      measureStore.setState({ focus: 'm1' });
      // the person moves a vertex
      put({ points: ring.map(([e, n, z], k) => (k === 0 ? [e + 1, n, z] : [e, n, z])) });
      await vi.waitFor(
        () => {
          expect(stored()?.results[0]?.carried).toBeUndefined();
        },
        { timeout: 5000 },
      );
      const m = stored();
      expect(m?.results[0]?.status).toBe('ok');
      expect(m?.previousResults).toEqual([
        expect.objectContaining({ netM3: 60, totalM3: 64, label: 'kit, Best-fit plane' }),
      ]);
      expect(m?.updatedAt).not.toBe(UPDATED);
    } finally {
      off();
      measureStore.setState({ focus: null });
    }
  });

  it('a carried pile left as it was is not taken as accepted', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [kit(must(r?.results[0]), 'e2')] });
    const off = followMeasurements();
    try {
      compareStore.setState({ computed: {}, current: {} });
      measureStore.setState({ focus: 'm1' });
      // a label is not an input
      put({ label: 'Renamed' });
      await vi.waitFor(() => {
        const s = compareStore.getState();
        expect(s.computed.m1).toBeDefined();
        expect(s.running.m1).toBe(false);
      });
      expect(stored()?.results[0]?.carried?.epoch).toBe('e2');
    } finally {
      off();
      measureStore.setState({ focus: null });
    }
  });

  it('Recompute all keeps a carried pile only while its points are as they were', async () => {
    const r = await compute('m1', { live: true });
    const off = followMeasurements();
    try {
      put({ results: [kit(must(r?.results[0]), 'e2')] });
      expect(keepsCarried(must(stored()))).toBe(true);
      put({ label: 'Renamed' });
      expect(keepsCarried(must(stored()))).toBe(true);
      put({ points: ring.map((p): [number, number, number] => [p[0] + 1, p[1], p[2]]) });
      expect(hasCarried(must(stored()))).toBe(true);
      expect(keepsCarried(must(stored()))).toBe(false);
    } finally {
      off();
    }
  });

  it('a cancelled spread run is no longer computing', async () => {
    put({
      items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    });
    const spy = vi.spyOn(engineClient(), 'spread').mockRejectedValueOnce(new RunCancelled());
    expect(await computeSpread('m1')).toBeNull();
    expect(compareStore.getState().spreads.m1).toBeUndefined();
    spy.mockRestore();
  });

  it('read-only: computeSeries holds the dates in memory and writes nothing', async () => {
    measureStore.setState({ readOnly: true });
    const series = vi.spyOn(engineClient(), 'series');
    const spread = vi.spyOn(engineClient(), 'spread');
    const before = measureStore.getState().savedText;
    // a client opening a package sees the whole volume history, as the report prints it
    expect(await computeSeries('m1')).toBe(true);
    expect(series).toHaveBeenCalled();
    expect(stored()?.series?.map((r) => r.toCapture)).toEqual(['c1', 'c2']);
    expect(measureStore.getState().resultsUnwritten).toBe(false);
    expect(writes()).toBe(0);
    expect(measureStore.getState().savedText).not.toBe(before);
    // nothing else is computed or stored in a read-only project
    put({
      items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    });
    expect(await computeSpread('m1')).toBeNull();
    expect(await recomputeStandard('m1')).not.toBeNull();
    expect(spread).not.toHaveBeenCalled();
    expect(writes()).toBe(0);
  });

  it('no spread next to a figure carried from the kit', async () => {
    const smart = { id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false };
    const m: SurveyMeasurement = { ...pit, items: [smart as SurveyMeasurement['items'][number]] };
    expect(spreadItem(m)?.id).toBe('a');
    const r = await compute('m1', { live: true });
    const carried = kit(must(r?.results[0]), 'e1');
    expect(spreadItem({ ...m, results: [carried] })).toBeNull();
    // a pile absent on the latest date: carried figures over time only
    expect(spreadItem({ ...m, series: [carried] })).toBeNull();
    put({ items: m.items, results: [carried] });
    const spy = vi.spyOn(engineClient(), 'spread');
    expect(await computeSpread('m1')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('spread is memoised per fingerprint', async () => {
    put({
      items: [{ id: 'a', from: { kind: 'smart' }, to: { kind: 'current' }, useDeadband: false }],
    });
    const spy = vi.spyOn(engineClient(), 'spread');
    const a = await computeSpread('m1');
    expect(a?.nets.length).toBeGreaterThanOrEqual(2);
    expect(await computeSpread('m1')).toEqual(a);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(compareStore.getState().spreads.m1?.value).toEqual(a);
    // not stored on the measurement
    expect(JSON.stringify(measureStore.getState().file)).not.toContain('nets');

    // other inputs, another fingerprint: computed again
    put({ points: ring.map(([e, n, z]) => [e + 0.5, n, z]) });
    await computeSpread('m1');
    expect(spy).toHaveBeenCalledTimes(2);

    // a base outside the spread bases has none, and nothing is run
    put({
      items: [
        {
          id: 'a',
          from: { kind: 'reference', mode: 'level', levelM: 100 },
          to: { kind: 'current' },
          useDeadband: false,
        },
      ],
    });
    expect(await computeSpread('m1')).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('recomputeStandard says why when nothing ran: engine not ready, too few points', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [kit(must(r?.results[0]), 'e2')] });
    compareStore.setState({ status: 'loading' });
    expect(await recomputeStandard('m1')).toBe(t('vol.card.engineStarting'));
    compareStore.setState({ status: 'ready' });
    put({ points: ring.slice(0, 2) });
    expect(await recomputeStandard('m1')).toBe(t('vol.card.needPoints'));
    // the carried figure stays
    expect(stored()?.results[0]?.carried).toBeDefined();
  });

  it('recomputeStandard replaces a carried figure with the engine one and keeps was', async () => {
    const r = await compute('m1', { live: true });
    const fresh = must(r?.results[0]);
    put({
      results: [kit(fresh, 'e2')],
      series: [kit({ ...fresh, toCapture: 'c1' }, 'e1')],
    });
    expect(await recomputeStandard('m1')).toBeNull();
    const m = stored();
    expect(m?.results).toHaveLength(1);
    expect(m?.results[0]?.carried).toBeUndefined();
    expect(m?.results[0]?.fingerprint).toBe(fresh.fingerprint);
    expect(m?.previousResults).toEqual([
      expect.objectContaining({ netM3: 60, totalM3: 64, label: 'kit, Best-fit plane' }),
    ]);
    // the carried figures over time go; the engine computes those dates on demand
    expect(m?.series).toBeUndefined();
    // the person accepted it: an edit
    expect(m?.updatedAt).not.toBe(UPDATED);
    expect(isStale(compareStore.getState(), must(m), must(m?.results[0]))).toBe(false);
  });

  it('Recompute all keeps carried kit figures and their history', async () => {
    // a pile with no carried figure: Recompute all stores it as the person's edit
    await computeAll(['m1']);
    expect(stored()?.updatedAt).not.toBe(UPDATED);
    put({ updatedAt: UPDATED });
    const r = await compute('m1', { live: true });
    const fresh = must(r?.results[0]);
    put({
      results: [kit(fresh, 'e2')],
      series: [kit({ ...fresh, toCapture: 'c1' }, 'e1')],
    });
    expect(carriedIds(['m1'])).toEqual(['m1']);
    await computeAll(['m1']);
    const m = stored();
    expect(m?.results[0]?.carried?.epoch).toBe('e2');
    expect(m?.results[0]?.netM3).toBe(60);
    expect(m?.series?.[0]?.carried?.epoch).toBe('e1');
    expect(m?.previousResults).toBeUndefined();
    // nothing the person changed
    expect(m?.updatedAt).toBe(UPDATED);
  });

  it('recomputeCarried accepts the standard base for each carried pile, keeping was', async () => {
    const r = await compute('m1', { live: true });
    put({ results: [kit(must(r?.results[0]), 'e2')] });
    expect(await recomputeCarried(['m1'])).toEqual([]);
    const m = stored();
    expect(m?.results[0]?.carried).toBeUndefined();
    expect(m?.previousResults).toHaveLength(1);
    expect(carriedIds(['m1'])).toEqual([]);
  });
});
