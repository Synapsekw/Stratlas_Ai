import { changeStore, registerChangeProducer, type ChangePairContext } from '@aio/change';
import type { ProjectManifest } from '@aio/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rerunProducer } from './rerun';

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
