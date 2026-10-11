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
    expect(call.mock.calls.map((c) => c[0] as string)).toEqual([
      'builder:ensureCapture',
      'jobs:start',
    ]);
    expect(paramsOfStart()).not.toHaveProperty('capture');
  });

  it('builds the maps without a date when adding the date throws', async () => {
    call.mockImplementation((channel: string) =>
      channel === 'builder:ensureCapture'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(started),
    );
    const err = await startProducts('r5', {
      ...base,
      products: ['ortho'],
      captureDate: '2026-04-02',
    });
    expect(err).toBeNull();
    expect(call).toHaveBeenCalledWith('jobs:start', expect.anything());
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

describe('startProducts when the start is refused', () => {
  const refused = { ok: true, value: { ok: false, error: 'No pipeline pack is installed.' } };
  const queued = { ...base, products: ['ortho'], capture: 'c2' } as const;

  it('drops the queued maps and keeps the reason and the survey date for the run', async () => {
    call.mockResolvedValue(refused);
    const ui = photoUi.getState();
    ui.setDate('q1', { capture: 'c2' });
    ui.setPending('q1', { ...queued, products: ['ortho'] });
    const err = await startProducts('q1', { ...queued, products: ['ortho'] });
    expect(err).toBe('No pipeline pack is installed.');
    const after = photoUi.getState();
    // nothing starts by itself any more: the run panel offers Create maps again
    expect(after.pending.q1).toBeUndefined();
    expect(after.startErrors.q1).toBe('No pipeline pack is installed.');
    // the next try still files the maps under the photos' survey date
    expect(after.dates.q1).toEqual({ capture: 'c2' });
  });

  it('keeps the reason when main cannot be reached at all', async () => {
    call.mockResolvedValue({ ok: false, error: 'The app is busy. Try again.' });
    photoUi.getState().setPending('q2', { ...queued, products: ['ortho'] });
    expect(await startProducts('q2', { ...queued, products: ['ortho'] })).toBe(
      'The app is busy. Try again.',
    );
    expect(photoUi.getState().pending.q2).toBeUndefined();
    expect(photoUi.getState().startErrors.q2).toBe('The app is busy. Try again.');
  });

  it('answers a reason instead of throwing when the call itself fails', async () => {
    call.mockRejectedValue(new Error('channel closed'));
    photoUi.getState().setPending('q3', { ...queued, products: ['ortho'] });
    expect(await startProducts('q3', { ...queued, products: ['ortho'] })).toBe('channel closed');
    expect(photoUi.getState().pending.q3).toBeUndefined();
    expect(photoUi.getState().startErrors.q3).toBe('channel closed');
  });

  it('a queue without outputs is dropped with its reason too', async () => {
    photoUi.getState().setPending('q4', { ...base, products: [] });
    expect(await startProducts('q4', { ...base, products: [] })).toBe(
      'Choose at least one product.',
    );
    expect(call).not.toHaveBeenCalled();
    expect(photoUi.getState().pending.q4).toBeUndefined();
    expect(photoUi.getState().startErrors.q4).toBe('Choose at least one product.');
  });

  it('the reason goes when the maps do start', async () => {
    call.mockResolvedValueOnce(refused).mockResolvedValue(started);
    photoUi.getState().setDate('q5', { capture: 'c2' });
    await startProducts('q5', { ...queued, products: ['ortho'] });
    expect(photoUi.getState().startErrors.q5).toBeDefined();
    expect(await startProducts('q5', { ...queued, products: ['ortho'] })).toBeNull();
    expect(photoUi.getState().startErrors.q5).toBeUndefined();
    expect(paramsOfStart()).toMatchObject({ run: 'q5', capture: 'c2' });
    expect(photoUi.getState().dates.q5).toBeUndefined();
  });
});
