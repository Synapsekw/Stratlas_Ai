import type { JobRecord, LineUpMeasure } from '@aio/schema';
import { createWorkspace } from '@aio/workspace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLineUpMemory } from './lineUpMemory';
import { createLineUpSession, measureWith, type LineUpSessionDeps } from './lineUpSession';
import { lineUpApp } from './lineUpStore';
import { lineUpManifest, measureOf } from './testing';

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
  const readJson = vi.fn<LineUpSessionDeps['readJson']>(() => Promise.resolve(measureOf()));
  const deps: LineUpSessionDeps = {
    workspace,
    root: () => 'C:/p',
    start,
    finished,
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
  return { workspace, deps, start, finished, readJson };
}

afterEach(() => {
  lineUpApp.setState({ store: null, preview: null, extents: null });
});

describe('line-up session', () => {
  it('measures through the change.lineup job', async () => {
    const { deps, start, finished, readJson } = setup();
    const r = await measureWith(deps)('d1', 'd2');
    expect(start).toHaveBeenCalledWith('change.lineup', 'C:/p', { keep: 'd1', move: 'd2' });
    expect(finished).toHaveBeenCalledWith('job-1');
    expect(readJson).toHaveBeenCalledWith('jobs/job-1/lineup.json');
    expect(r).toEqual<LineUpMeasure>(measureOf());
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
    session.stop();
    expect(lineUpApp.getState().store).toBeNull();
  });
});
