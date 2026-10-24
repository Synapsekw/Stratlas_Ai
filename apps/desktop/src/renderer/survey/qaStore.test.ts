// @vitest-environment jsdom
import type { HeightTiles, JobRecord, ProjectManifest } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Job = Pick<JobRecord, 'id' | 'pipeline' | 'project' | 'status'>;

const h = vi.hoisted(() => {
  const listeners = new Set<(st: unknown) => void>();
  const state = {
    jobs: [] as Job[],
    selected: null as string | null,
    surfaces: [] as unknown[],
    started: [] as { pipeline: string; project: string; params: Record<string, unknown> }[],
  };
  const jobsApi = {
    getState: () => ({
      jobs: state.jobs,
      selected: state.selected,
      init: () => Promise.resolve(),
      start: (req: (typeof state.started)[number]) => {
        state.started.push(req);
        // the prepare it asks for runs and ends at once
        const id = `own-${String(state.started.length)}`;
        state.jobs = [
          ...state.jobs,
          { id, pipeline: req.pipeline, project: req.project, status: 'done' } as Job,
        ];
        state.selected = id;
        return Promise.resolve(null);
      },
    }),
    subscribe: (cb: (st: unknown) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const notify = () => {
    for (const cb of [...listeners]) cb(jobsApi.getState());
  };
  return { state, jobsApi, notify };
});

vi.mock('../shell', () => ({
  jobs: h.jobsApi,
  bridge: {
    call: (channel: string) => {
      if (channel === 'survey:surfaces')
        return Promise.resolve({ ok: true, value: { ok: true, surfaces: h.state.surfaces } });
      if (channel === 'survey:readQa')
        return Promise.resolve({ ok: true, value: { ok: true, files: [], readOnly: false } });
      return Promise.resolve({
        ok: true,
        value: { ok: true, file: { schema: 'aio.terrain-edits/1', edits: [] } },
      });
    },
  },
}));

const { prepareCapture, qaStore } = await import('./qaStore');

const ROOT = 'C:/projects/p';
const manifest = {
  captures: [{ id: 'd2', label: 'Survey 6 April 2026', date: '2026-04-06' }],
  layers: [{ id: 'dsm-2', kind: 'raster', role: 'dsm', capture: 'd2', name: 'DSM' }],
} as unknown as ProjectManifest;
const surface = (capture: string) =>
  ({ id: `dsm-${capture}`, capture, source: { kind: 'dsm', layer: 'dsm-2' } }) as HeightTiles;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Survey QA's Prepare beside a running prepare job", () => {
  beforeEach(() => {
    h.state.jobs = [];
    h.state.selected = null;
    h.state.surfaces = [];
    h.state.started = [];
    qaStore.setState({ projectId: 'p', root: ROOT, surfaces: [], busy: null, message: null });
  });

  it('waits for the background prepare and uses the surface it made, starting none', async () => {
    h.state.jobs = [{ id: 'bg', pipeline: 'survey.prepare', project: ROOT, status: 'running' }];
    const done = prepareCapture(manifest, 'd2');
    await flush();
    // busy while it waits, and nothing started beside the running job
    expect(qaStore.getState().busy).not.toBeNull();
    expect(h.state.started).toEqual([]);
    // the background job ends, having prepared the survey
    h.state.surfaces = [surface('d2')];
    h.state.jobs = [{ id: 'bg', pipeline: 'survey.prepare', project: ROOT, status: 'done' }];
    h.notify();
    await done;
    expect(h.state.started).toEqual([]);
    expect(qaStore.getState().surfaces.map((s) => s.id)).toEqual(['dsm-d2']);
    expect(qaStore.getState().busy).toBeNull();
    expect(qaStore.getState().message).toBeNull();
  });

  it('starts its own prepare once the running job ended without that survey', async () => {
    h.state.jobs = [{ id: 'bg', pipeline: 'survey.prepare', project: ROOT, status: 'running' }];
    const done = prepareCapture(manifest, 'd2');
    await flush();
    expect(h.state.started).toEqual([]);
    h.state.jobs = [{ id: 'bg', pipeline: 'survey.prepare', project: ROOT, status: 'failed' }];
    h.notify();
    await done;
    expect(h.state.started.map((s) => s.pipeline)).toEqual(['survey.prepare']);
    expect(qaStore.getState().busy).toBeNull();
  });

  it('prepares at once when no prepare job is at work on the project', async () => {
    h.state.jobs = [
      { id: 'other', pipeline: 'survey.prepare', project: 'C:/projects/q', status: 'running' },
    ];
    await prepareCapture(manifest, 'd2');
    expect(h.state.started.map((s) => s.project)).toEqual([ROOT]);
  });
});
