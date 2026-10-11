import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const replaceManifest = vi.fn();
const open: { project: { id: string; root: string } | null } = {
  project: { id: 'p1', root: 'D:\\Projects\\site' },
};

vi.mock('../shell', () => ({
  bridge: { call: (...a: unknown[]) => call(...a) as unknown },
  jobs: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));
vi.mock('@aio/workspace', () => ({
  workspace: { getState: () => ({ project: open.project, replaceManifest }) },
}));

import { startProducts } from './actions';
import { photoUi } from './store';

const base = { root: 'D:/Projects/site/', preset: 'standard', products: ['ortho'] } as const;
const started = { ok: true, value: { ok: true } };
const paramsOfStart = () =>
  (call.mock.calls.find((c) => c[0] === 'jobs:start')?.[1] as { params: Record<string, unknown> })
    .params;

beforeEach(() => {
  call.mockReset();
  replaceManifest.mockReset();
  open.project = { id: 'p1', root: 'D:\\Projects\\site' };
});

describe('startProducts and the survey date', () => {
  it('adds the date of a new day first, then starts the maps under its id', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? {
              ok: true,
              value: { ok: true, manifest: { captures: [] }, captureId: 'capture-2026-04-02' },
            }
          : started,
      ),
    );
    photoUi.getState().setDate('r1', { captureDate: '2026-04-02' });
    const err = await startProducts('r1', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'jobs:start',
    ]);
    expect(call).toHaveBeenNthCalledWith(1, 'builder:ensureCapture', {
      projectId: 'p1',
      date: '2026-04-02',
    });
    expect(paramsOfStart()).toMatchObject({ run: 'r1', capture: 'capture-2026-04-02' });
    expect(paramsOfStart()).not.toHaveProperty('captureDate');
    expect(replaceManifest).toHaveBeenCalledTimes(1);
    expect(photoUi.getState().dates.r1).toBeUndefined();
  });

  it('a date that exists is used as it is', async () => {
    call.mockResolvedValue(started);
    await startProducts('r2', { ...base, products: ['ortho'], capture: 'c2' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).toMatchObject({ capture: 'c2' });
  });

  it('builds the maps without a date when the date cannot be added', async () => {
    call.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'builder:ensureCapture'
          ? { ok: true, value: { ok: false, error: 'no' } }
          : started,
      ),
    );
    const err = await startProducts('r3', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });

  it('adds no date to another project that happens to be open', async () => {
    open.project = { id: 'p2', root: 'D:\\Projects\\other' };
    call.mockResolvedValue(started);
    await startProducts('r4', { ...base, products: ['ortho'], captureDate: '2026-04-02' });
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual(['jobs:start']);
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });
});
