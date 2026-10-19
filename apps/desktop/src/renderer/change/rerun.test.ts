import { changeStore, registerChangeProducer, type ChangePairContext } from '@aio/change';
import type { JobRecord, ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProducerDeps } from './producers/raster';
import { rerunProducer, rerunScoped } from './rerun';

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
  it('replays the stored params unchanged (never a whole-map run)', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    expect(await rerunScoped('change.surface', P, deps(start))).toBeNull();
    expect(start).toHaveBeenCalledWith('change.surface', 'E:/proj', P);
  });
  it('prefixes a bare producer name', async () => {
    const start = vi.fn().mockResolvedValue({ jobId: 'j' });
    await rerunScoped('raster', P, deps(start));
    expect(start).toHaveBeenCalledWith('change.raster', 'E:/proj', P);
  });
  it('returns a start error as the sentence', async () => {
    const start = vi.fn().mockResolvedValue({ error: 'No elevation.' });
    expect(await rerunScoped('raster', P, deps(start))).toBe('No elevation.');
  });
  it('refuses a producer that is not scoped change', async () => {
    const start = vi.fn();
    expect(await rerunScoped('change.cloud', P, deps(start))).toBe(
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
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(setMisaligned).toHaveBeenLastCalledWith({
      from: 'c1',
      to: 'c2',
      shiftM: 2.5,
      producer: 'raster',
      params: P,
    });
  });
});
