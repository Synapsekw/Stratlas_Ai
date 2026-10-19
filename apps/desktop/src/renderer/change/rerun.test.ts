import { changeStore, registerChangeProducer, type ChangePairContext } from '@aio/change';
import { fromWgs84 } from '@aio/geo';
import {
  emptyMeasurements,
  type JobRecord,
  type LonLatRing,
  type ProjectManifest,
  type SurveyMeasurement,
} from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProducerDeps } from './producers/raster';

vi.mock('../shell', () => ({
  bridge: { call: () => Promise.resolve({ ok: false, error: 'Not configured' }) },
  shell: { getState: () => ({ screen: 'scene', go: vi.fn() }) },
}));

const { areaRingNow, rerunProducer, rerunScoped } = await import('./rerun');
const { measureStore } = await import('../survey/measureStore');

const ctx: ChangePairContext = {
  projectId: 'p',
  manifest: {} as ProjectManifest,
  from: 'c1',
  to: 'c2',
  layersFrom: [],
  layersTo: [],
};
const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
  vi.restoreAllMocks();
});
const register = (
  run: () => Promise<{ ok: true; ids?: string[] } | { ok: false; error: string }>,
) => {
  const producer = {
    id: 'raster',
    label: 'Run imagery change',
    kinds: ['region' as const],
    available: () => true as const,
    run,
  };
  offs.push(registerChangeProducer(producer));
  return producer;
};

describe('run again', () => {
  it('shows the error of a run that does not start', async () => {
    register(() => Promise.resolve({ ok: false, error: 'No pack.' }));
    expect(await rerunProducer('change.raster', ctx)).toBe('No pack.');
  });

  it('reads the new change sets like the panel button does', async () => {
    const load = vi.spyOn(changeStore.getState(), 'load').mockResolvedValue(undefined);
    register(() => Promise.resolve({ ok: true, ids: ['c1-c2-raster'] }));
    expect(await rerunProducer('raster', ctx)).toBeNull();
    expect(load).toHaveBeenCalledWith('p');
  });

  it('runs an in-app comparison through the store, and nothing unknown', async () => {
    const compute = vi.spyOn(changeStore.getState(), 'compute').mockResolvedValue(true);
    expect(await rerunProducer('issues', ctx)).toBeNull();
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await rerunProducer('mystery', ctx)).toBe('This comparison cannot be run again here.');
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await rerunProducer('raster', null)).toBe('This comparison cannot be run again here.');
  });
});

describe('rerunScoped', () => {
  const P = { scope: { id: 'a', name: 'A' }, mask: { type: 'Polygon' }, from: 'c1', to: 'c2' };
  const deps = (start: ProducerDeps['start'], extra: Partial<ProducerDeps> = {}): ProducerDeps => ({
    root: () => 'E:/proj',
    thresholds: () => undefined,
    start,
    projectId: () => 'p',
    ...extra,
  });
  /** The polygon where it is drawn now (after a new line-up of its date). */
  const NOW: LonLatRing = [
    [48.1, 29.1],
    [48.2, 29.1],
    [48.2, 29.2],
  ];
  const here = vi.fn((id: string) => (id === 'a' ? { ring: NOW } : { reason: 'gone' }));
  const P2 = { ...P, mask: NOW };
  it('replays the stored params with the polygon where it is now (never a whole-map run)', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    expect(await rerunScoped('change.raster', P, deps(start), here)).toBeNull();
    expect(here).toHaveBeenCalledWith('a');
    expect(start).toHaveBeenCalledWith('change.raster', 'E:/proj', P2);
  });
  it('moves the area of a volume run with its mask', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    const S = { ...P, areas: [{ id: 'a', name: 'A', ring: P.mask }] };
    await rerunScoped('change.surface', S, deps(start), here);
    expect(start).toHaveBeenCalledWith('change.surface', 'E:/proj', {
      ...S,
      mask: NOW,
      areas: [{ id: 'a', name: 'A', ring: NOW }],
    });
  });
  it('says the area no longer exists when its polygon is gone, and runs nothing', async () => {
    const start = vi.fn();
    const gone = () => ({ reason: t('change.area.gone') });
    expect(await rerunScoped('raster', P, deps(start), gone)).toBe(
      'The area polygon no longer exists, so its comparison cannot run again.',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('refuses params without an area rather than run the whole map', async () => {
    const start = vi.fn();
    const whole = { ...P, scope: undefined };
    expect(await rerunScoped('raster', whole, deps(start), here)).toBe(
      'This comparison cannot be run again here.',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('prefixes a bare producer name', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    await rerunScoped('raster', P, deps(start), here);
    expect(start).toHaveBeenCalledWith('change.raster', 'E:/proj', P2);
  });
  it('returns a start error as the sentence', async () => {
    const start = vi.fn().mockResolvedValue({ error: 'No elevation.' });
    expect(await rerunScoped('raster', P, deps(start), here)).toBe('No elevation.');
  });
  it('refuses a producer that is not scoped change', async () => {
    const start = vi.fn();
    expect(await rerunScoped('change.cloud', P, deps(start), here)).toBe(
      'This comparison cannot be run again here.',
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('keeps a refusal for the gap with its params, for the Line up offer', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    const setMisaligned = vi.fn();
    const job = {
      id: 'j',
      status: 'failed',
      failure: { code: 'misaligned', data: { from: 'c1', to: 'c2', shiftM: 2.5 } },
    } as unknown as JobRecord;
    await rerunScoped(
      'raster',
      P,
      deps(start, { finished: () => Promise.resolve(job), setMisaligned }),
      here,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(setMisaligned).toHaveBeenLastCalledWith({
      from: 'c1',
      to: 'c2',
      shiftM: 2.5,
      producer: 'raster',
      params: P2,
    });
  });
});

describe('the area polygon where it is now', () => {
  const E0 = 500000;
  const N0 = 3200000;
  const manifest = {
    crs: { epsg: 32639 },
    origin: [E0, N0, 0],
    layers: [],
    captures: [
      { id: 'c1', label: 'March', date: '2026-03-01' },
      {
        id: 'c2',
        label: 'April',
        date: '2026-04-01',
        lineUp: { eastM: 5, northM: 0, with: 'c1', at: '2026-10-01T00:00:00Z' },
      },
    ],
  } as unknown as ProjectManifest;
  const pad: SurveyMeasurement = {
    id: 'pad',
    family: 'polygon',
    tool: 'area',
    label: 'Pad A',
    scope: { kind: 'survey', capture: 'c2' },
    points: [
      [E0, N0, 0],
      [E0 + 10, N0, 0],
      [E0 + 10, N0 + 10, 0],
    ],
    items: [],
    results: [],
    createdAt: '2026-10-01T00:00:00Z',
  };
  afterEach(() => {
    workspace.getState().closeProject();
  });
  it('takes the open project and its measurements, the date line-up applied', async () => {
    workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
    const file = { ...emptyMeasurements(), measurements: [pad] };
    measureStore.setState({ file, projectId: 'p1', status: 'ready' });
    const r = await areaRingNow('pad');
    if (!('ring' in r)) throw new Error(r.reason);
    const [e] = fromWgs84([...(r.ring[0] ?? [0, 0]), 0], 32639);
    expect(e - E0).toBeCloseTo(5, 3);
  });
  it('says the area no longer exists once the polygon is deleted', async () => {
    workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
    measureStore.setState({ file: emptyMeasurements(), projectId: 'p1', status: 'ready' });
    expect(await areaRingNow('pad')).toEqual({ reason: t('change.area.gone') });
  });
  it('waits for the measurements of the open project to load', async () => {
    workspace.getState().openProject({ id: 'p1', root: '/p1', manifest });
    measureStore.setState({ file: emptyMeasurements(), projectId: 'p1', status: 'loading' });
    expect(await areaRingNow('pad')).toEqual({ reason: t('change.area.measuresLoading') });
  });
});
