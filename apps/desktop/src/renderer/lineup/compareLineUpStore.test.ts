import type { CaptureLineUp, LineUpMeasure } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chipOf, createCompareLineUp } from './compareLineUpStore';
import type { LineUpDeps } from './lineUpStore';
import { forgetMeasures, measureKey, remember } from './lineUpWatch';
import { fitOf, lineUpManifest, measureOf } from './testing';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A measurement that waits until the test answers it, and sees its abort. */
function pending() {
  const calls: {
    keep: string;
    move: string;
    signal: AbortSignal | undefined;
    answer: (m: LineUpMeasure | { error: string }) => void;
  }[] = [];
  const measure = vi.fn<LineUpDeps['measure']>(
    (keep, move, signal) =>
      new Promise((resolve) => {
        calls.push({ keep, move, signal, answer: resolve });
      }),
  );
  return { measure, calls };
}

function setup(measure: LineUpDeps['measure']) {
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
  const store = createCompareLineUp({ measure, workspace });
  return { workspace, store };
}

const LINED: CaptureLineUp = { eastM: 2, northM: 0, with: 'd1', at: '2026-10-18T10:00:00.000Z' };

afterEach(() => {
  forgetMeasures();
});

describe('compare line-up status', () => {
  it('measures the pair once and caches by shifts', async () => {
    const measure = vi.fn<LineUpDeps['measure']>(() => Promise.resolve(measureOf()));
    const { store } = setup(measure);
    store.getState().watch('d1', 'd2');
    expect(store.getState().status).toBe('measuring');
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure.mock.calls[0]?.slice(0, 2)).toEqual(['d1', 'd2']);
    expect(store.getState()).toMatchObject({ pair: 'd1|d2||', status: 'off' });

    // the comparison closed and opened again: the cache answers at once
    store.getState().stop();
    expect(store.getState().status).toBe('idle');
    store.getState().watch('d1', 'd2');
    expect(store.getState().status).toBe('off');
    expect(measure).toHaveBeenCalledTimes(1);

    // a background answer for another pair fills the same cache
    const { store: other } = setup(measure);
    remember('d2|d1||', measureOf({ keep: 'd2', move: 'd1', verdict: 'aligned' }));
    other.getState().watch('d2', 'd1');
    expect(other.getState().status).toBe('lined');
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('a new line-up re-measures', async () => {
    const measure = vi
      .fn<LineUpDeps['measure']>()
      .mockResolvedValueOnce(measureOf())
      .mockResolvedValueOnce(measureOf({ verdict: 'aligned', totalM: 0.02 }));
    const { workspace, store } = setup(measure);
    store.getState().watch('d1', 'd2');
    await flush();
    expect(store.getState().status).toBe('off');

    // the right-hand date is lined up: the pair is measured as it now stands
    workspace
      .getState()
      .openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest({ lineUps: { d2: LINED } }) });
    const m = workspace.getState().project?.manifest;
    expect(m && measureKey(m, 'd1', 'd2')).toBe('d1|d2||2,0');
    await flush();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(store.getState()).toMatchObject({ pair: 'd1|d2||2,0', status: 'lined' });
  });

  it('switching cancels and ignores the stale answer', async () => {
    const { measure, calls } = pending();
    const manifest = lineUpManifest({
      captures: [
        { id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' },
        { id: 'd2', label: 'Survey 13 April 2026', date: '2026-04-13' },
        { id: 'd3', label: 'Survey 1 June 2026', date: '2026-06-01' },
      ],
    });
    const workspace = createWorkspace();
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest });
    const store = createCompareLineUp({ measure, workspace });
    store.getState().watch('d1', 'd2');
    store.getState().watch('d1', 'd3');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(calls[1]?.signal?.aborted).toBe(false);

    calls[0]?.answer(measureOf({ verdict: 'aligned' }));
    await flush();
    expect(store.getState()).toMatchObject({ pair: 'd1|d3||', status: 'measuring' });

    calls[1]?.answer(measureOf({ move: 'd3', verdict: 'texture' }));
    await flush();
    expect(store.getState().status).toBe('cannot');
    expect(store.getState().reason).toMatch(/texture|detail/i);
  });

  it('maps verdicts, the fit first', () => {
    expect(chipOf(measureOf()).status).toBe('off');
    expect(chipOf(measureOf({ verdict: 'aligned' })).status).toBe('lined');
    for (const verdict of ['texture', 'disagree', 'overlap'] as const)
      expect(chipOf(measureOf({ verdict }))).toMatchObject({ status: 'cannot' });
    expect(chipOf({ error: 'The job failed.' })).toEqual({
      status: 'cannot',
      reason: 'The measurement did not finish: The job failed.',
    });
    // a measurement with a fit (Task 5) is judged by the fit
    const fitted = measureOf({ fit: fitOf({ verdict: 'range', maxMoveM: 3 }) });
    expect(chipOf(fitted).status).toBe('cannot');
    expect(chipOf(fitted).reason).toBeTruthy();
  });

  it('measures again after a failure once the manifest changes', async () => {
    const measure = vi
      .fn<LineUpDeps['measure']>()
      .mockResolvedValueOnce({ error: 'The job failed.' })
      .mockResolvedValueOnce(measureOf());
    const { workspace, store } = setup(measure);
    store.getState().watch('d1', 'd2');
    await flush();
    expect(store.getState().status).toBe('cannot');
    // the same pair, the same shifts: a refusal would hold, a failure is tried again
    const m = workspace.getState().project?.manifest;
    if (m) workspace.getState().replaceManifest({ ...m, name: 'Renamed' });
    await flush();
    expect(measure).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe('off');
  });

  it('resumes once both dates exist', async () => {
    const measure = vi.fn<LineUpDeps['measure']>(() => Promise.resolve(measureOf()));
    const workspace = createWorkspace();
    workspace.getState().openProject({
      id: 'p',
      root: 'C:/p',
      manifest: lineUpManifest({
        captures: [{ id: 'd1', label: 'Survey 2 March 2026', date: '2026-03-02' }],
      }),
    });
    const store = createCompareLineUp({ measure, workspace });
    store.getState().watch('d1', 'd2');
    expect(store.getState().status).toBe('idle');
    workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('off');
  });

  it('stops following the workspace once disposed', async () => {
    const measure = vi.fn<LineUpDeps['measure']>(() => Promise.resolve(measureOf()));
    const { workspace, store } = setup(measure);
    store.getState().watch('d1', 'd2');
    await flush();
    store.getState().dispose();
    expect(store.getState().status).toBe('idle');
    workspace
      .getState()
      .openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest({ lineUps: { d2: LINED } }) });
    await flush();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('idle');
  });
});
