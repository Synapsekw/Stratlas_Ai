import type { JobRecord, LineUpMeasure } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { createStore } from 'zustand/vanilla';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLineUpMemory } from './lineUpMemory';
import {
  createLineUpSession,
  MEASURE_LIMIT_MS,
  linkNotices,
  measureWith,
  writersFor,
  type LineUpSessionDeps,
} from './lineUpSession';
import { compareLineUpApp } from './compareLineUpStore';
import { lineUpApp } from './lineUpStore';
import { fitOf, lineUpManifest, measureOf } from './testing';

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  id: 'job-1',
  pipeline: 'change.lineup',
  project: 'C:/p',
  params: {},
  status: 'done',
  progress: 1,
  steps: [],
  artifacts: [],
  createdAt: '2026-10-17T10:00:00.000Z',
  updatedAt: '2026-10-17T10:00:00.000Z',
  ...over,
});

function setup(over: Partial<LineUpSessionDeps> = {}) {
  const workspace = createWorkspace();
  workspace.getState().openProject({ id: 'p', root: 'C:/p', manifest: lineUpManifest() });
  const start = vi.fn<LineUpSessionDeps['start']>(() => Promise.resolve({ jobId: 'job-1' }));
  const finished = vi.fn<LineUpSessionDeps['finished']>(() => Promise.resolve(job()));
  const cancel = vi.fn<LineUpSessionDeps['cancel']>();
  // an older pipeline pack by default: lineup.json and no lineup-fit.json beside it
  const readJson = vi.fn<LineUpSessionDeps['readJson']>((path) =>
    path.endsWith('/lineup.json')
      ? Promise.resolve(measureOf())
      : Promise.reject(new Error(`${path} could not be read (404).`)),
  );
  const deps: LineUpSessionDeps = {
    workspace,
    root: () => 'C:/p',
    start,
    finished,
    cancel,
    readJson,
    extents: vi.fn(() => Promise.resolve({})),
    hasPython: () => false,
    preview: vi.fn(() => Promise.resolve(null)),
    saveCapture: vi.fn(() => Promise.resolve(null)),
    pinCaptures: vi.fn(() => Promise.resolve(null)),
    hints: () => ({ layers: {}, epochs: {} }),
    issues: () => [],
    measurements: () => [],
    memory: createLineUpMemory(null),
    now: () => '2026-10-17T10:00:00.000Z',
    ...over,
  };
  return { workspace, deps, start, finished, readJson, cancel };
}

afterEach(() => {
  lineUpApp.setState({ store: null, preview: null, extents: null });
});

describe('line-up session', () => {
  it('measures through the change.lineup job', async () => {
    const { deps, start, finished, readJson } = setup();
    const r = await measureWith(deps)('d1', 'd2');
    expect(start).toHaveBeenCalledWith('change.lineup', 'C:/p', { keep: 'd1', move: 'd2' });
    expect(finished).toHaveBeenCalledWith('job-1', expect.any(AbortSignal));
    expect(readJson).toHaveBeenCalledWith('jobs/job-1/lineup.json');
    expect(r).toEqual<LineUpMeasure>(measureOf());
  });

  it('older pack without lineup-fit.json stays shift-only', async () => {
    const { deps, readJson } = setup();
    const r = await measureWith(deps)('d1', 'd2');
    expect(readJson).toHaveBeenCalledWith('jobs/job-1/lineup-fit.json');
    expect(r).toEqual<LineUpMeasure>(measureOf());
    expect(r).not.toHaveProperty('fit');
  });

  it('reads the turn and scale from lineup-fit.json', async () => {
    const fit = fitOf();
    const { deps } = setup({
      readJson: (path) => Promise.resolve(path.endsWith('/lineup-fit.json') ? fit : measureOf()),
    });
    expect(await measureWith(deps)('d1', 'd2')).toEqual<LineUpMeasure>(measureOf({ fit }));

    const garbled = setup({
      readJson: (path) =>
        Promise.resolve(path.endsWith('/lineup-fit.json') ? { rotationDeg: 'x' } : measureOf()),
    });
    expect(await measureWith(garbled.deps)('d1', 'd2')).toEqual({
      error: 'The measurement could not be read.',
    });
  });

  it('reports a failed measurement', async () => {
    const failed = setup({
      finished: () => Promise.resolve(job({ status: 'failed', error: 'No ortho on d2.' })),
    });
    expect(await measureWith(failed.deps)('d1', 'd2')).toEqual({ error: 'No ortho on d2.' });
    expect(failed.readJson).not.toHaveBeenCalled();

    // an older installed pipeline pack without change.lineup
    const older = setup({
      start: () => Promise.resolve({ error: 'Unknown pipeline change.lineup.' }),
    });
    expect(await measureWith(older.deps)('d1', 'd2')).toEqual({
      error: 'Unknown pipeline change.lineup.',
    });

    const garbled = setup({ readJson: () => Promise.resolve({ verdict: 'maybe' }) });
    expect(await measureWith(garbled.deps)('d1', 'd2')).toEqual({
      error: 'The measurement could not be read.',
    });

    const missing = setup({ readJson: () => Promise.reject(new Error('lineup.json (404).')) });
    expect(await measureWith(missing.deps)('d1', 'd2')).toEqual({ error: 'lineup.json (404).' });

    const noProject = setup({ root: () => null });
    expect(await measureWith(noProject.deps)('d1', 'd2')).toEqual({
      error: 'Open a project first.',
    });
    expect(noProject.start).not.toHaveBeenCalled();
  });

  it('hands the step to the dialog and takes it back on stop', () => {
    const { deps } = setup();
    const session = createLineUpSession(deps);
    expect(lineUpApp.getState().store).toBe(session.store);
    expect(lineUpApp.getState().preview).toBe(deps.preview);
    expect(lineUpApp.getState().extents).toBe(deps.extents);
    expect(compareLineUpApp.getState().store).not.toBeNull();
    expect(compareLineUpApp.getState().workspace).toBe(deps.workspace);
    session.stop();
    expect(lineUpApp.getState().store).toBeNull();
    expect(compareLineUpApp.getState().store).toBeNull();
  });

  it('says so when the job is not known any more', async () => {
    const { deps } = setup({ finished: () => Promise.resolve(null) });
    expect(await measureWith(deps)('d1', 'd2')).toEqual({
      error: 'The job is not known any more.',
    });
  });

  /** A wait that ends with null when its signal aborts, like `waitForJob`. */
  const stalls: LineUpSessionDeps['finished'] = (_id, signal) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        resolve(null);
      });
    });

  it('stops measuring and cancels the job when another project opens', async () => {
    const { workspace, deps, cancel } = setup({ finished: stalls });
    const pending = measureWith(deps)('d1', 'd2');
    await Promise.resolve();
    workspace.getState().openProject({ id: 'q', root: 'C:/q', manifest: lineUpManifest() });
    expect(await pending).toEqual({
      error: 'Another project was opened, so the measurement was stopped.',
    });
    expect(cancel).toHaveBeenCalledWith('job-1');
  });

  it('stops measuring and cancels the job when its signal aborts', async () => {
    const { deps, cancel } = setup({ finished: stalls });
    const ctl = new AbortController();
    const pending = measureWith(deps)('d1', 'd2', ctl.signal);
    await Promise.resolve();
    ctl.abort();
    expect(await pending).toEqual({ error: 'The measurement was stopped.' });
    expect(cancel).toHaveBeenCalledWith('job-1');

    // aborted before it began: no job is started
    const early = setup({ finished: stalls });
    const gone = new AbortController();
    gone.abort();
    expect(await measureWith(early.deps)('d1', 'd2', gone.signal)).toEqual({
      error: 'The measurement was stopped.',
    });
    expect(early.start).not.toHaveBeenCalled();
  });

  it('stops a stalled job after the limit', async () => {
    vi.useFakeTimers();
    try {
      const { deps, cancel } = setup({ finished: stalls });
      const pending = measureWith(deps)('d1', 'd2');
      await vi.advanceTimersByTimeAsync(MEASURE_LIMIT_MS + 1);
      expect(await pending).toEqual({ error: 'The measurement took too long and was stopped.' });
      expect(cancel).toHaveBeenCalledWith('job-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names how an ended job ended', async () => {
    for (const [status, text] of [
      ['cancelled', 'The job was cancelled.'],
      ['interrupted', 'The job was interrupted.'],
      ['failed', 'The job failed.'],
    ] as const) {
      const { deps } = setup({ finished: () => Promise.resolve(job({ status })) });
      expect(await measureWith(deps)('d1', 'd2')).toEqual({ error: text });
    }
  });

  it('checks the next project after a switch stopped the first measurement', async () => {
    const box = (x0: number) => ({
      min: [x0, 0, 0] as [number, number, number],
      max: [x0 + 100, 5, 100] as [number, number, number],
    });
    const { workspace, deps, start } = setup({
      finished: stalls,
      hasPython: () => true,
      extents: () => Promise.resolve({ o1: box(0), o2: box(10), c2: box(10) }),
    });
    const session = createLineUpSession(deps);
    try {
      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledTimes(1);
      });
      workspace.getState().openProject({ id: 'q', root: 'C:/q', manifest: lineUpManifest() });
      await vi.waitFor(() => {
        expect(start).toHaveBeenCalledTimes(2);
      });
    } finally {
      session.stop();
    }
  });
});

describe('line-up wiring', () => {
  it('writes a line-up through builder:updateCapture and a pin through the layer save', async () => {
    const updateCapture = vi.fn(() => Promise.resolve<string | null>(null));
    const saveLayers = vi.fn(() => Promise.resolve<string | null>('refused'));
    const { saveCapture, pinCaptures } = writersFor({ updateCapture, saveLayers });
    const lineUp = { eastM: 1, northM: 2, with: 'd1', at: '2026-10-17T10:00:00.000Z' };
    const lineUpTurn = { rotationDeg: 0.25, scale: 1.0035, pivotE: 500050, pivotN: 3999975 };
    expect(await saveCapture('d2', lineUp, lineUpTurn)).toBeNull();
    expect(updateCapture).toHaveBeenCalledWith('d2', { lineUp, lineUpTurn });
    // always both: a plain shift takes a stored turn off
    await saveCapture('d2', lineUp, null);
    expect(updateCapture).toHaveBeenLastCalledWith('d2', { lineUp, lineUpTurn: null });
    await saveCapture('d2', null, null);
    expect(updateCapture).toHaveBeenLastCalledWith('d2', { lineUp: null, lineUpTurn: null });
    expect(await pinCaptures(['a', 'b'], 'd2')).toBe('refused');
    expect(saveLayers).toHaveBeenCalledWith(['a', 'b'], { capture: 'd2' });
    await pinCaptures(['a'], null);
    expect(saveLayers).toHaveBeenLastCalledWith(['a'], { capture: null });
  });

  it('lets one notice with Undo send the others away', () => {
    const notice = (action: boolean) => ({ notice: action ? { action: {} } : null });
    const mk = () => {
      const dismiss = vi.fn();
      return {
        dismiss,
        store: createStore<{ notice: unknown; dismiss: () => void }>(() => ({
          ...notice(false),
          dismiss,
        })),
      };
    };
    const ours = mk();
    const align = mk();
    const drop = mk();
    const off = linkNotices(ours.store, [align.store, drop.store]);
    ours.store.setState(notice(true));
    expect(align.dismiss).toHaveBeenCalledTimes(1);
    expect(drop.dismiss).toHaveBeenCalledTimes(1);
    expect(ours.dismiss).not.toHaveBeenCalled();
    drop.store.setState(notice(true));
    expect(ours.dismiss).toHaveBeenCalledTimes(1);
    expect(align.dismiss).toHaveBeenCalledTimes(1);
    // a notice without Undo does not displace the others
    align.store.setState(notice(false));
    expect(ours.dismiss).toHaveBeenCalledTimes(1);
    off();
    ours.store.setState({ notice: { action: {} } });
    expect(align.dismiss).toHaveBeenCalledTimes(1);
  });
});
